"""Evaluate the preregistered Chronos-Bolt Small experiment without model tuning.

The saved protocol predates inference. Existing rolling results are read-only.
"""
from pathlib import Path
import argparse
import hashlib
import importlib.metadata
import inspect
import json
import os
import platform
import time
from datetime import datetime, timezone

for variable in ('OMP_NUM_THREADS', 'OPENBLAS_NUM_THREADS', 'MKL_NUM_THREADS'):
    os.environ.setdefault(variable, '2')
os.environ.setdefault('HF_HUB_DISABLE_TELEMETRY', '1')
os.environ.setdefault('HF_HUB_DISABLE_XET', '1')
import numpy as np
import pandas as pd
import torch
from chronos import ChronosBoltPipeline
from huggingface_hub import snapshot_download

ROOT = Path(__file__).resolve().parents[2]
PROTOCOL_PATH = Path(__file__).with_name('chronos-protocol.json')
QS = np.array([.1, .5, .75, .9])
SERIES = [
    {'seriesId': 'chronos/raw', 'variantId': 'raw', 'modelId': 'chronos-bolt-small', 'group': 'chronos', 'name': 'Chronos-Bolt Small · 원시 zero-shot'},
    {'seriesId': 'chronos/daily56', 'variantId': 'daily56', 'modelId': 'chronos-bolt-small', 'group': 'chronos', 'name': 'Chronos-Bolt Small · 매일 56일 보정'},
]


def sha(path):
    hasher = hashlib.sha256()
    with Path(path).open('rb') as file:
        for block in iter(lambda: file.read(1024*1024), b''):
            hasher.update(block)
    return hasher.hexdigest()


def coherent(values):
    q = np.maximum(0, np.array(values, dtype=float, copy=True))
    q[:, 0] = np.minimum(q[:, 0], q[:, 1])
    q[:, 2] = np.maximum(q[:, 2], q[:, 1])
    q[:, 3] = np.maximum(q[:, 3], q[:, 2])
    assert np.isfinite(q).all()
    return q


def quantity(q75):
    nearest = np.rint(q75)
    return np.ceil(np.where(np.abs(q75-nearest) < 1e-9, nearest, q75)).astype(np.int64)


def metrics(frame):
    error = np.abs(frame.y.to_numpy()-frame.p50.to_numpy())
    over = np.maximum(frame.quantity.to_numpy()-frame.y.to_numpy(), 0)
    under = np.maximum(frame.y.to_numpy()-frame.quantity.to_numpy(), 0)
    actual = float(frame.y.sum())
    return {'n': len(frame), 'actualTotal': actual, 'absoluteError': float(error.sum()),
            'wape': float(100*error.sum()/actual), 'mae': float(error.mean()),
            'over': int(over.sum()), 'under': int(under.sum()),
            'loss': int(over.sum()+3*under.sum())}


def context_for(daily, product, date):
    date = pd.Timestamp(date)
    calendar = pd.date_range(end=date-pd.Timedelta(days=1), periods=512, freq='D')
    observed = daily[daily['product'] == product].set_index('date').y
    values = observed.reindex(calendar).to_numpy(dtype=np.float32)
    assert len(values) == 512 and calendar[-1] == date-pd.Timedelta(days=1)
    assert (calendar < date).all() and np.isfinite(values).any()
    audit = {'date': str(date.date()), 'product': int(product), 'contextFirstDate': str(calendar[0].date()),
             'contextLastDate': str(calendar[-1].date()), 'calendarSlots': 512,
             'observedSlots': int(np.isfinite(values).sum()), 'nanSlots': int(np.isnan(values).sum()),
             'contextSha256': hashlib.sha256(values.astype('<f4').tobytes()).hexdigest()}
    return values, audit


def official_forecast(pipeline, contexts):
    tensor = torch.tensor(np.array(contexts), dtype=torch.float32, device='cpu')
    with torch.inference_mode():
        requested, unused_native_median = pipeline.predict_quantiles(
            tensor, prediction_length=1, quantile_levels=QS.tolist())
        native = pipeline.predict(tensor, prediction_length=1)
    assert requested.shape == (len(contexts), 1, 4)
    assert native.shape == (len(contexts), 9, 1)
    # Independent reconstruction of the official interpolation, including sorting.
    native_at_horizon = native[:, :, 0]
    augmented = torch.cat([native_at_horizon[:, [0]], native_at_horizon, native_at_horizon[:, [-1]]], dim=1)
    rebuilt = torch.quantile(augmented, torch.tensor(QS, dtype=torch.float32), dim=1).T
    torch.testing.assert_close(requested[:, 0, :], rebuilt, rtol=0, atol=0)
    assert np.isfinite(requested.numpy()).all() and np.isfinite(native.numpy()).all()
    return requested[:, 0, :].numpy().astype(float), native_at_horizon.numpy().astype(float)


def calibrated_predictions(dates, products, actual, raw, cal_count, target_dates=None):
    dates = pd.DatetimeIndex(dates)
    result, updates = [], []
    for index in range(cal_count, len(dates)):
        target = dates[index]
        if target_dates is not None and target not in target_dates:
            continue
        past = (dates < target)&(products == products[index])
        rows = np.flatnonzero(past&(dates >= target-pd.Timedelta(days=56)))
        fallback = len(rows) < 10
        if fallback:
            rows = np.flatnonzero(past)[-56:]
        assert len(rows) and (dates[rows] < target).all()
        correction = np.array([np.quantile(actual[rows]-raw[rows, k], tau) for k, tau in enumerate(QS)])
        q = coherent((raw[index]+correction)[None, :])[0]
        result.append((index, q))
        updates.append({'date': str(target.date()), 'product': int(products[index]),
            'residualFirstOutcome': str(dates[rows].min().date()), 'residualLatestOutcome': str(dates[rows].max().date()),
            'residualRows': len(rows), 'usedSparseFallback': fallback,
            'newObservedHistoryUsed': bool((rows >= cal_count).any()),
            'correctionP50': float(correction[1]), 'correctionP75': float(correction[2])})
    return result, updates


def make_frame(split_id, series, dates, products, actual, result):
    indices = np.array([i for i, q in result])
    predicted = np.array([q for i, q in result])
    return pd.DataFrame({'seriesId': series['seriesId'], 'variantId': series['variantId'],
        'modelId': series['modelId'], 'group': series['group'], 'splitId': split_id,
        'date': pd.DatetimeIndex(dates)[indices].strftime('%Y-%m-%d'), 'product': products[indices],
        'y': actual[indices], 'p50': predicted[:, 1], 'q75': predicted[:, 2],
        'quantity': quantity(predicted[:, 2])})


def scored_rows(frame, references, series):
    result = []
    ref_scores = [metrics(group) for _, group in references.groupby('seriesId')]
    assert len(ref_scores) == 35
    for s in series:
        row = {**s, **metrics(frame[frame.seriesId == s['seriesId']])}
        if s['group'] == 'chronos':
            row['rankVsRolling35'] = {key: 1+sum(r[key] < row[key]-1e-10 for r in ref_scores)
                                      for key in ['loss', 'wape', 'mae']}
            row['rankComparisonCount'] = 36
        result.append(row)
    return result


def paired_bootstrap(frame, variant_id, reference_id, block_days, seed):
    keys = ['splitId', 'date', 'product']
    a = frame[frame.seriesId == variant_id].set_index(keys).sort_index()
    b = frame[frame.seriesId == reference_id].set_index(keys).sort_index()
    assert a.index.equals(b.index) and np.array_equal(a.y, b.y)
    over = np.maximum(a.quantity-a.y, 0)-np.maximum(b.quantity-b.y, 0)
    under = np.maximum(a.y-a.quantity, 0)-np.maximum(b.y-b.quantity, 0)
    difference = (over+3*under).rename('delta').reset_index()
    samples, rng = np.zeros(1000), np.random.default_rng(seed)
    for split_id, fold in difference.groupby('splitId'):
        calendar = pd.date_range(fold.date.min(), fold.date.max())
        daily = fold.groupby('date').delta.sum()
        daily.index = pd.to_datetime(daily.index)
        values = daily.reindex(calendar, fill_value=0).to_numpy(float)
        starts = rng.integers(0, len(values), size=(1000, int(np.ceil(len(values)/block_days))))
        indices = ((starts[:, :, None]+np.arange(block_days)) % len(values)).reshape(1000, -1)[:, :len(values)]
        samples += values[indices].sum(axis=1)
    low, high = np.percentile(samples, [2.5, 97.5])
    delta = int(difference.delta.sum())
    return {'variantSeriesId': variant_id, 'referenceSeriesId': reference_id,
        'direction': 'Chronos minus reference; negative lossDelta favors Chronos',
        'blockDays': block_days, 'samples': 1000, 'seed': seed, 'lossDelta': delta,
        'overDelta': int(over.sum()), 'underDelta': int(under.sum()), 'weightedUnderDelta': int(3*under.sum()),
        'relativeLossDeltaPercent': float(100*delta/metrics(b.reset_index())['loss']),
        'confidence95': [float(low), float(high)], 'confidenceIncludesZero': bool(low <= 0 <= high),
        'bootstrapProbabilityImprovement': float(np.mean(samples < 0))}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source', type=Path, default=ROOT/'work'/'benchmark-34814876448')
    parser.add_argument('--output', type=Path, default=ROOT/'public'/'research'/'chronos')
    parser.add_argument('--rolling', type=Path, default=ROOT/'public'/'research'/'rolling')
    args = parser.parse_args()
    started = time.time()
    protocol = json.loads(PROTOCOL_PATH.read_text(encoding='utf-8'))
    print(json.dumps({'stage': 'preregistered', 'protocolSha256': sha(PROTOCOL_PATH), 'protocol': protocol}), flush=True)
    assert protocol['registeredBeforeInference'] and not protocol['fineTune']
    pinned = {'chronos-forecasting': protocol['chronosPackage'], 'transformers': protocol['transformersPackage'],
              'torch': protocol['torchPackage'], 'numpy': protocol['numpyPackage'], 'pandas': protocol['pandasPackage']}
    versions = {name: importlib.metadata.version(name) for name in pinned}
    assert versions == pinned, (versions, pinned)
    torch.set_num_threads(protocol['cpuThreads'])
    torch.set_num_interop_threads(1)
    torch.manual_seed(protocol['seed'])
    np.random.seed(protocol['seed'])
    torch.use_deterministic_algorithms(True)
    source_research = args.source/'research'/'rebuild'
    base = json.loads((args.source/'public'/'research'/'benchmark.json').read_text(encoding='utf-8'))
    rolling = json.loads((args.rolling/'analysis.json').read_text(encoding='utf-8'))
    source_paths = [source_research/'daily-sales.csv', args.rolling/'predictions.csv', args.rolling/'analysis.json',
                    args.source/'public'/'research'/'benchmark.json']
    preserved_hashes = {str(p): sha(p) for p in source_paths}
    daily = pd.read_csv(source_research/'daily-sales.csv', parse_dates=['date'])
    assert len(daily) == 3505 and not daily.duplicated(['date', 'product']).any()
    bundles, key_set = {}, set()
    for split in base['splits']:
        path = source_research/(split['id']+'.npz')
        preserved_hashes[str(path)] = sha(path)
        with np.load(path, allow_pickle=False) as stored:
            bundle = {name: stored[name] for name in stored.files}
        bundles[split['id']] = bundle
        key_set.update(zip(bundle['dates_eval'].tolist(), bundle['product_eval'].tolist()))
    keys = sorted(key_set)
    contexts, context_audit = [], []
    for date, product in keys:
        context, audit = context_for(daily, product, date)
        contexts.append(context)
        context_audit.append(audit)
    contexts = np.array(contexts, dtype=np.float32)
    key_index = {key: i for i, key in enumerate(keys)}
    model_dir = Path(snapshot_download(protocol['modelId'], revision=protocol['modelRevision'],
        allow_patterns=['config.json', 'model.safetensors'], cache_dir=ROOT/'work'/'chronos-model-cache'))
    weights = model_dir/'model.safetensors'
    assert weights.stat().st_size == protocol['weightsBytes'] and sha(weights) == protocol['weightsSha256']
    config = json.loads((model_dir/'config.json').read_text(encoding='utf-8'))
    assert config['chronos_config']['context_length'] == 2048
    assert np.allclose(config['chronos_config']['quantiles'], np.arange(.1, 1, .1))
    pipeline = ChronosBoltPipeline.from_pretrained(model_dir, device_map='cpu', torch_dtype=torch.float32, local_files_only=True)
    pipeline.model.eval()
    assert not pipeline.model.training
    assert all(parameter.dtype == torch.float32 and parameter.device.type == 'cpu' for parameter in pipeline.model.parameters())
    # Compatibility smoke test happens before scoring any evaluation observation.
    smoke = contexts[:2].copy()
    smoke[:, 10] = np.nan
    smoke_q, smoke_native = official_forecast(pipeline, smoke)
    assert smoke_q.shape == (2, 4) and smoke_native.shape == (2, 9)
    print(json.dumps({'stage': 'smoke-passed', 'nanInputAccepted': True,
        'officialQuantileInterpolationMatched': True, 'device': 'cpu', 'dtype': 'float32'}), flush=True)
    raw_parts, native_parts = [], []
    inference_started = time.time()
    for start in range(0, len(keys), protocol['batchSize']):
        predicted, native = official_forecast(pipeline, contexts[start:start+protocol['batchSize']])
        raw_parts.append(predicted)
        native_parts.append(native)
        print(json.dumps({'stage': 'inference', 'completed': min(start+protocol['batchSize'], len(keys)), 'total': len(keys)}), flush=True)
    requested_raw, native_raw = np.concatenate(raw_parts), np.concatenate(native_parts)
    inference_seconds = time.time()-inference_started
    raw = coherent(requested_raw)
    negative_count = int((requested_raw < 0).sum())
    crossing_rows = int((np.diff(native_raw, axis=1) < 0).any(axis=1).sum())
    # For each distinct test day, rebuild its context from mutated source data.
    # Since the complete512 input is identical, inference is identical by construction;
    # actual model reruns below additionally check first/middle/last dates per fold.
    unique_test_dates = sorted({str(d) for b in bundles.values() for d in b['dates_eval'][int(b['cal_count']):]})
    context_mutation_checks = 0
    for date in unique_test_dates:
        mutated = daily.copy()
        mutated.loc[mutated.date >= pd.Timestamp(date), 'y'] += 123456
        for product in sorted(daily['product'].unique()):
            if (date, int(product)) in key_index:
                changed, _ = context_for(mutated, product, date)
                np.testing.assert_array_equal(changed, contexts[key_index[(date, int(product))]])
                context_mutation_checks += 1
    actual_model_mutation_checks = 0
    for split in base['splits']:
        b = bundles[split['id']]
        dates = sorted(set(b['dates_eval'][int(b['cal_count']):].tolist()))
        selected_dates = {dates[0], dates[len(dates)//2], dates[-1]}
        for date in selected_dates:
            selected = [key_index[k] for k in keys if k[0] == date]
            mutated = daily.copy()
            mutated.loc[mutated.date >= pd.Timestamp(date), 'y'] += 123456
            changed_contexts = [context_for(mutated, keys[i][1], date)[0] for i in selected]
            changed_prediction, _ = official_forecast(pipeline, changed_contexts)
            # Floating-point batched matrix kernels can differ slightly with a
            # different batch size; compare unchanged and mutated inputs together.
            unchanged_prediction, _ = official_forecast(pipeline, contexts[selected])
            np.testing.assert_array_equal(changed_prediction, unchanged_prediction)
            np.testing.assert_allclose(changed_prediction, requested_raw[selected], atol=1e-4, rtol=1e-6)
            actual_model_mutation_checks += len(selected)
    old_predictions = pd.read_csv(args.rolling/'predictions.csv', dtype={'date': str}, float_precision='round_trip')
    rank_ids = [s['seriesId'] for s in rolling['series'] if s['group'] == 'rolling']+['custom/custom-weekly-daily']
    assert len(rank_ids) == 35
    reference_pool = old_predictions[old_predictions.seriesId.isin(rank_ids)].copy()
    reference_series = [s for s in rolling['series'] if s['seriesId'] in protocol['referenceSeries']]
    series = SERIES+reference_series
    frames = [old_predictions[old_predictions.seriesId.isin(protocol['referenceSeries'])].copy()]
    updates, fold_checks = [], []
    for split in base['splits']:
        b = bundles[split['id']]
        dates, products, actual = b['dates_eval'], b['product_eval'], b['y_eval']
        cal_count = int(b['cal_count'])
        selected = [key_index[(str(d), int(p))] for d, p in zip(dates, products)]
        raw_fold = raw[selected]
        frames.append(make_frame(split['id'], SERIES[0], dates, products, actual, [(i, raw_fold[i]) for i in range(cal_count, len(dates))]))
        result, audit = calibrated_predictions(dates, products, actual, raw_fold, cal_count)
        frames.append(make_frame(split['id'], SERIES[1], dates, products, actual, result))
        updates.extend([{'splitId': split['id'], **row} for row in audit])
        # Test each prediction date: changing its own/future outcomes cannot affect
        # any same-date residual-calibrated result.
        mutation_cases = 0
        for target in sorted(set(pd.DatetimeIndex(dates[cal_count:]))):
            changed_y = actual.copy()
            changed_y[pd.DatetimeIndex(dates) >= target] += 123456
            changed, _ = calibrated_predictions(dates, products, changed_y, raw_fold, cal_count, {target})
            expected = [(i, q) for i, q in result if pd.Timestamp(str(dates[i])) == target]
            np.testing.assert_array_equal([q for i, q in changed], [q for i, q in expected])
            mutation_cases += len(changed)
        fold_checks.append({'splitId': split['id'], 'n': split['n'], 'calibrationForecastRows': cal_count,
            'testForecastRows': len(dates)-cal_count, 'everyTargetResidualMutationCases': mutation_cases,
            'everyCalibrationRowDateStrictlyBeforeTarget': True})
    output = args.output.resolve()
    output.mkdir(parents=True, exist_ok=True)
    predictions = pd.concat(frames, ignore_index=True)
    predictions.to_csv(output/'predictions.csv', index=False, float_format='%.17g')
    exported = pd.read_csv(output/'predictions.csv', dtype={'date': str}, float_precision='round_trip')
    assert len(exported) == 5*974
    assert not exported.duplicated(['seriesId', 'splitId', 'date', 'product']).any()
    comparison_keys = ['splitId', 'date', 'product']
    expected = reference_pool[reference_pool.seriesId == 'custom/custom-weekly-daily'].set_index(comparison_keys).sort_index()
    for series_id, group in exported.groupby('seriesId'):
        observed = group.set_index(comparison_keys).sort_index()
        assert observed.index.equals(expected.index) and np.array_equal(observed.y, expected.y)
        assert np.isfinite(observed[['y', 'p50', 'q75', 'quantity']].to_numpy()).all()
        assert np.array_equal(observed.quantity, quantity(observed.q75.to_numpy()))
        assert (observed.q75 >= observed.p50).all() and (observed.p50 >= 0).all()
        before = metrics(predictions[predictions.seriesId == series_id])
        after = metrics(group)
        for metric in before:
            assert np.isclose(before[metric], after[metric], rtol=1e-11, atol=1e-8)
    aggregate = scored_rows(exported, reference_pool, series)
    by_split = [{'splitId': s['id'], **row} for s in base['splits']
                for row in scored_rows(exported[exported.splitId == s['id']], reference_pool[reference_pool.splitId == s['id']], series)]
    by_product = [{'product': p['id'], 'productName': p['name'], **row} for p in base['dataset']['products']
                  for row in scored_rows(exported[exported['product'] == p['id']], reference_pool[reference_pool['product'] == p['id']], series)]
    paired = [paired_bootstrap(exported, s['seriesId'], r, days, protocol['seed']+days)
              for s in SERIES for r in protocol['referenceSeries'] for days in [7, 14]]
    raw_table = pd.DataFrame({'date': [d for d, p in keys], 'product': [p for d, p in keys],
        **{f'nativeP{int(round(q*100))}': native_raw[:, i] for i, q in enumerate(np.arange(.1, 1, .1))},
        **{f'requestedP{int(round(q*100))}': requested_raw[:, i] for i, q in enumerate(QS)}})
    raw_table.to_csv(output/'raw-quantiles.csv', index=False, float_format='%.17g')
    pd.DataFrame(updates).to_csv(output/'daily-updates.csv', index=False, float_format='%.17g')
    pd.DataFrame(context_audit).to_csv(output/'contexts.csv', index=False)
    pd.DataFrame([{**row, **{f'rank_{k}': v for k, v in row.get('rankVsRolling35', {}).items()}}
                  for row in aggregate]).drop(columns=['rankVsRolling35']).to_csv(output/'results.csv', index=False, float_format='%.17g')
    for path, digest in preserved_hashes.items():
        assert sha(path) == digest, 'Existing source changed: '+path
    verification = {'status': 'passed', 'same974ObservationKeysForEverySeries': True, 'predictionRows': len(exported),
        'chronosScoredPredictionRows': 2*974, 'uniqueActualInferenceContexts': len(keys),
        'contextsIncludeCalibrationDates': True, 'allContextsExactly512CalendarSlots': True,
        'missingDatesRetainedAsNaN': True, 'everyContextEndsTargetMinusOneDay': True,
        'ownAndFutureSourceMutationContextCases': context_mutation_checks,
        'ownAndFutureSourceMutationActualModelCases': actual_model_mutation_checks,
        'everyScoredDayResidualMutationInvariant': True, 'originalSourceHashesPreserved': True,
        'checkpointWeightSha256Verified': True, 'librariesMatchProtocolPins': True,
        'officialQuantileInterpolationIndependentlyReconstructed': True,
        'allFinite': True, 'duplicatePredictionKeys': 0, 'allMetricsRecomputedFromExportedCsv': True,
        'fineTuned': False, 'nativeCrossingRows': crossing_rows,
        'negativeRequestedQuantileCellsClipped': negative_count, 'folds': fold_checks}
    implementation_paths = [Path(inspect.getfile(ChronosBoltPipeline)), Path(inspect.getfile(ChronosBoltPipeline)).with_name('base.py')]
    provenance = {'protocolSha256': sha(PROTOCOL_PATH), 'scriptSha256': sha(Path(__file__)),
        'modelId': protocol['modelId'], 'modelRevision': protocol['modelRevision'], 'weightsSha256': sha(weights),
        'configSha256': sha(model_dir/'config.json'), 'parameterCount': sum(p.numel() for p in pipeline.model.parameters()),
        'libraries': versions, 'implementationSha256': {p.name: sha(p) for p in implementation_paths},
        'sourceHashes': preserved_hashes, 'platform': platform.platform(),
        'inferenceSeconds': inference_seconds, 'cpuThreads': protocol['cpuThreads'], 'device': 'cpu', 'dtype': 'float32',
        'workflowRunId': os.environ.get('GITHUB_RUN_ID'), 'sourceCommit': os.environ.get('GITHUB_SHA')}
    analysis = {'version': 'chronos-bolt-small-bakery-v1', 'status': 'completed',
        'generatedAt': datetime.now(timezone.utc).isoformat(), 'seed': protocol['seed'],
        'primarySeriesId': 'chronos/daily56', 'primaryVariantId': 'daily56', 'protocol': protocol,
        'dataset': base['dataset'], 'splits': base['splits'], 'series': series, 'variants': SERIES,
        'aggregate': aggregate, 'bySplit': by_split, 'byProduct': by_product, 'pairedComparisons': paired,
        'provenance': provenance, 'verification': verification, 'elapsedSeconds': time.time()-started,
        'artifacts': {name: '/research/chronos/'+name for name in ['analysis.json', 'predictions.csv', 'results.csv', 'methodology.md',
            'verification.json', 'raw-quantiles.csv', 'daily-updates.csv', 'contexts.csv', 'protocol.json']}}
    for name, payload in [('analysis.json', analysis), ('verification.json', verification), ('protocol.json', protocol)]:
        (output/name).write_text(json.dumps(payload, ensure_ascii=False, indent=2, allow_nan=False), encoding='utf-8')
    lines = ['# Chronos-Bolt Small과 베이커리 모델 비교', '',
        '추론 전에 고정한 공식 체크포인트·CPU FP32·512달력일 문맥·다음날1일 예측으로 평가했습니다. 모델 가중치 미세조정은 하지 않았습니다.', '',
        '두 방식은 원시 zero-shot과 최근56일의 관측 오차로 날짜마다 보정한 방식입니다. 같은974개 관측을 채점하며 기존 결과는 보존했습니다.', '',
        '## 평가 규칙', '']
    lines += ['- **'+key+'**: '+str(value) for key, value in protocol.items() if isinstance(value, (str, int, float))]
    lines += ['', '## 전체 결과', '', '| 방식 | WAPE | MAE | 과다 | 부족 | 가중손실 | 36개 중 손실 순위 |', '|---|---:|---:|---:|---:|---:|---:|']
    for row in aggregate:
        lines.append(f"| {row['name']} | {row['wape']:.4f}% | {row['mae']:.4f} | {row['over']} | {row['under']} | {row['loss']} | {row.get('rankVsRolling35', {}).get('loss', '참조')} |")
    lines += ['', '## 해석 범위', '',
        'Chronos − 기존 참조의 차이를 보고하므로 음수 손실차가 Chronos에 유리합니다. 7일·14일 블록 신뢰구간을 함께 보며, 이미 탐색한 단일 매장 자료의 결과를 모든 매장의 우위로 일반화하지 않습니다.',
        'zero-shot은 이번 평가에서 가중치를 학습하지 않았다는 뜻입니다. 사전학습에 이 공개자료가 포함되지 않았음까지 확인한 것은 아닙니다.', '',
        '## 공식 자료', '']+[f'- {url}' for url in protocol['officialSources']]
    (output/'methodology.md').write_text('\n'.join(lines)+'\n', encoding='utf-8')
    print(json.dumps({'status': 'completed', 'aggregate': aggregate, 'verification': verification, 'elapsedSeconds': time.time()-started}, ensure_ascii=True), flush=True)


if __name__ == '__main__':
    main()
