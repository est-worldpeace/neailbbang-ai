"""Six compact PyTorch quantile networks trained with fixed epochs and two seeds.

No evaluation target is passed to training. These are new small implementations,
not reproduction of unavailable original experiments. Neural ODE uses a learned
continuous-time drift integrated with eight explicit Euler steps.
"""
from __future__ import annotations

import math
import time
from typing import Any
import numpy as np
import torch
from torch import nn
from torch.nn import functional as F

QUANTILES = (0.1, 0.5, 0.75, 0.9)
MODEL_SPECS = {
    "mlp": {"name": "MLP", "hidden": [64, 32], "input": "tabular + flattened 28-day sequence"},
    "lstm": {"name": "LSTM", "hidden": 24, "layers": 1, "head_hidden": 32},
    "gru": {"name": "GRU", "hidden": 24, "layers": 1, "head_hidden": 32},
    "tcn": {"name": "TCN", "channels": 16, "kernel": 3, "dilations": [1, 2, 4, 8]},
    "transformer": {"name": "Transformer", "d_model": 16, "heads": 2, "layers": 1, "feedforward": 32},
    "neural-ode": {"name": "Neural ODE", "latent": 24, "drift_hidden": 32, "solver": "explicit Euler", "steps": 8, "integration_time": [0, 1]},
}
LAST_TRAINING_RUN: dict[str, Any] = {}

class QuantileHead(nn.Module):
    def __init__(self, features):
        super().__init__()
        self.layers = nn.Sequential(nn.Linear(features, 32), nn.ReLU(), nn.Linear(32, 4))
        nn.init.normal_(self.layers[-1].weight, std=0.01)
        with torch.no_grad():
            self.layers[-1].bias.copy_(torch.tensor([-0.5, -0.6, -1.1, -1.2]))
    def forward(self, features):
        return F.softplus(self.layers(features)).cumsum(dim=-1)

class MLP(nn.Module):
    def __init__(self, features):
        super().__init__()
        self.encoder = nn.Sequential(nn.Linear(features + 56, 64), nn.ReLU(), nn.Dropout(0.05))
        self.head = QuantileHead(64)
    def forward(self, tabular, sequence):
        return self.head(self.encoder(torch.cat((tabular, sequence.flatten(1)), dim=1)))

class Recurrent(nn.Module):
    def __init__(self, features, kind):
        super().__init__()
        cls = nn.LSTM if kind == "lstm" else nn.GRU
        self.encoder = cls(2, 24, num_layers=1, batch_first=True)
        self.head = QuantileHead(24 + features)
    def forward(self, tabular, sequence):
        hidden, _ = self.encoder(sequence)
        return self.head(torch.cat((hidden[:, -1, :], tabular), dim=1))

class CausalConv(nn.Module):
    def __init__(self, inputs, outputs, dilation):
        super().__init__()
        self.left_padding = 2 * dilation
        self.conv = nn.Conv1d(inputs, outputs, kernel_size=3, dilation=dilation)
        self.residual = nn.Conv1d(inputs, outputs, kernel_size=1) if inputs != outputs else nn.Identity()
    def forward(self, sequence):
        return F.relu(self.conv(F.pad(sequence, (self.left_padding, 0))) + self.residual(sequence))

class TCN(nn.Module):
    def __init__(self, features):
        super().__init__()
        self.encoder = nn.Sequential(CausalConv(2, 16, 1), CausalConv(16, 16, 2), CausalConv(16, 16, 4), CausalConv(16, 16, 8))
        self.head = QuantileHead(16 + features)
    def forward(self, tabular, sequence):
        hidden = self.encoder(sequence.transpose(1, 2))[:, :, -1]
        return self.head(torch.cat((hidden, tabular), dim=1))

class Transformer(nn.Module):
    def __init__(self, features):
        super().__init__()
        self.input_projection = nn.Linear(2, 16)
        position = torch.arange(28, dtype=torch.float32).unsqueeze(1)
        frequency = torch.exp(torch.arange(0, 16, 2, dtype=torch.float32) * (-math.log(10000.0) / 16))
        encoding = torch.zeros(28, 16)
        encoding[:, 0::2] = torch.sin(position * frequency)
        encoding[:, 1::2] = torch.cos(position * frequency)
        self.register_buffer("position_encoding", encoding.unsqueeze(0))
        layer = nn.TransformerEncoderLayer(d_model=16, nhead=2, dim_feedforward=32, dropout=0.05, batch_first=True)
        self.encoder = nn.TransformerEncoder(layer, num_layers=1, enable_nested_tensor=False)
        self.head = QuantileHead(16 + features)
    def forward(self, tabular, sequence):
        hidden = self.encoder(self.input_projection(sequence) + self.position_encoding)
        return self.head(torch.cat((hidden[:, -1, :], tabular), dim=1))

class NeuralODE(nn.Module):
    def __init__(self, features):
        super().__init__()
        self.initial_state = nn.Sequential(nn.Linear(56, 24), nn.Tanh())
        self.drift = nn.Sequential(nn.Linear(25, 32), nn.Tanh(), nn.Linear(32, 24), nn.Tanh())
        self.head = QuantileHead(24 + features)
    def forward(self, tabular, sequence):
        hidden = self.initial_state(sequence.flatten(1))
        for step in range(8):
            clock = torch.full((len(hidden), 1), step / 8, device=hidden.device, dtype=hidden.dtype)
            hidden = hidden + self.drift(torch.cat((hidden, clock), dim=1)) / 8
        return self.head(torch.cat((hidden, tabular), dim=1))

def _network(model_id, features):
    if model_id == "mlp": return MLP(features)
    if model_id in ("lstm", "gru"): return Recurrent(features, model_id)
    if model_id == "tcn": return TCN(features)
    if model_id == "transformer": return Transformer(features)
    if model_id == "neural-ode": return NeuralODE(features)
    raise ValueError(f"Unknown deep model: {model_id}")

def _array(value, shape_tail=None):
    result = np.asarray(value, dtype=np.float32)
    if not np.isfinite(result).all():
        raise ValueError("Inputs must contain only finite values after train-only preprocessing")
    if shape_tail is not None and result.shape[1:] != shape_tail:
        raise ValueError(f"Expected trailing shape {shape_tail}, got {result.shape}")
    return result

def fit_predict(model_id, X_train, seq_train, y_train, X_eval, seq_eval, seed=20260914, epochs=80):
    """Fit two CPU seeds, fixed epochs and AdamW; return raw-unit ordered quantiles.

    The caller fits tabular imputation/scaling on its training partition only.
    Sequence and target normalization use only the mean absolute training target.
    Evaluation inputs are used once after training and never tune hyperparameters.
    """
    global LAST_TRAINING_RUN
    if model_id not in MODEL_SPECS or not isinstance(epochs, int) or epochs < 1:
        raise ValueError("Known model_id and positive integer epochs are required")
    train_x, eval_x = _array(X_train), _array(X_eval)
    train_seq, eval_seq = _array(seq_train, (28, 2)), _array(seq_eval, (28, 2))
    target = _array(y_train).reshape(-1)
    if train_x.ndim != 2 or eval_x.ndim != 2 or train_x.shape[1] != eval_x.shape[1]:
        raise ValueError("X arrays must be two-dimensional with matching feature counts")
    if not len(target) or len(train_x) != len(target) or len(train_seq) != len(target) or len(eval_x) != len(eval_seq):
        raise ValueError("Empty training data or inconsistent sample counts")
    if (target < 0).any(): raise ValueError("Sales targets must be nonnegative")
    started = time.perf_counter()
    torch.set_num_threads(2)
    try: torch.set_num_interop_threads(1)
    except RuntimeError: pass
    torch.use_deterministic_algorithms(True)
    scale = max(float(np.mean(np.abs(target), dtype=np.float64)), 1.0)
    train_seq, eval_seq = train_seq.copy(), eval_seq.copy()
    train_seq[:, :, 0] /= scale
    eval_seq[:, :, 0] /= scale
    train_tensors = (torch.from_numpy(train_x), torch.from_numpy(train_seq), torch.from_numpy(target / scale))
    eval_tensors = (torch.from_numpy(eval_x), torch.from_numpy(eval_seq))
    qs = torch.tensor(QUANTILES, dtype=torch.float32).reshape(1, 4)
    predictions, reports = [], []
    for run_seed in (int(seed), int(seed) + 1):
        torch.manual_seed(run_seed)
        network = _network(model_id, train_x.shape[1])
        initial = [p.detach().clone() for p in network.parameters()]
        optimizer = torch.optim.AdamW(network.parameters(), lr=0.002, weight_decay=0.0001)
        scheduler = torch.optim.lr_scheduler.CosineAnnealingLR(optimizer, T_max=epochs, eta_min=0.0002)
        generator = torch.Generator().manual_seed(run_seed + 17)
        epoch_loss, first_loss, peak_grad = None, None, 0.0
        network.train()
        for epoch in range(epochs):
            total = 0.0
            order = torch.randperm(len(target), generator=generator)
            for indices in order.split(64):
                optimizer.zero_grad(set_to_none=True)
                estimated = network(train_tensors[0][indices], train_tensors[1][indices])
                difference = train_tensors[2][indices, None] - estimated
                loss = torch.maximum(qs * difference, (qs - 1) * difference).mean()
                if not torch.isfinite(loss):
                    raise FloatingPointError(f"Non-finite loss: {model_id}, seed {run_seed}, epoch {epoch + 1}")
                loss.backward()
                if any(p.grad is not None and not torch.isfinite(p.grad).all() for p in network.parameters()):
                    raise FloatingPointError(f"Non-finite gradient: {model_id}, seed {run_seed}")
                norm = nn.utils.clip_grad_norm_(network.parameters(), max_norm=5.0)
                peak_grad = max(peak_grad, float(norm))
                optimizer.step()
                total += loss.detach().item() * len(indices)
            scheduler.step()
            epoch_loss = total / len(target)
            if first_loss is None: first_loss = epoch_loss
            if (epoch + 1) % 20 == 0 or epoch + 1 == epochs:
                print(f"  {model_id} seed={run_seed} epoch={epoch + 1}/{epochs} train_pinball={epoch_loss:.6f}", flush=True)
        change = math.sqrt(sum(float(((p.detach() - old) ** 2).sum()) for p, old in zip(network.parameters(), initial)))
        if not change > 0: raise RuntimeError(f"No network parameters changed: {model_id}")
        network.eval()
        with torch.inference_mode():
            chunks = [network(eval_tensors[0][i:i + 256], eval_tensors[1][i:i + 256]).numpy() for i in range(0, len(eval_x), 256)]
        prediction = np.concatenate(chunks, axis=0) if chunks else np.empty((0, 4), dtype=np.float32)
        predictions.append(prediction.astype(np.float64) * scale)
        reports.append({"seed": run_seed, "epochs": epochs, "initialEpochTrainPinball": first_loss, "finalEpochTrainPinball": epoch_loss, "parameters": sum(p.numel() for p in network.parameters()), "parameterChangeL2": change, "maximumGradientL2": peak_grad})
    result = np.mean(predictions, axis=0)
    if not np.isfinite(result).all() or (np.diff(result, axis=1) < -1e-8).any():
        raise FloatingPointError("Invalid network quantile predictions")
    LAST_TRAINING_RUN = {
        "modelId": model_id, "architecture": MODEL_SPECS[model_id], "torchVersion": torch.__version__,
        "device": "cpu", "threads": 2, "trainRows": len(target), "evalRows": len(eval_x),
        "targetScaleFromTrain": scale, "quantiles": list(QUANTILES), "seedRuns": reports,
        "optimizer": "AdamW", "learningRate": 0.002, "weightDecay": 0.0001,
        "scheduler": "cosine to 0.0002", "batchSize": 64, "earlyStopping": False,
        "durationSeconds": round(time.perf_counter() - started, 3),
    }
    return result
