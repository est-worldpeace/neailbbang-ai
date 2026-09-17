"""Causal recalibration of preserved out-of-training predictions; never retrain models.

python research/rebuild/rolling_benchmark.py --source work/benchmark-34814876448
Optional --dependency-path is explicit and never loads the old python-deps folder.
"""
from pathlib import Path
import argparse
import hashlib
import json
import os
import sys
import time
from datetime import datetime, timezone

ROOT = Path(__file__).resolve().parents[2]
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--source', type=Path, default=ROOT/'work'/'benchmark-34814876448')
parser.add_argument('--output', type=Path, default=ROOT/'public'/'research'/'rolling')
parser.add_argument('--dependency-path', type=Path)
ARGS, _ = parser.parse_known_args()
if ARGS.dependency_path:
    sys.path.insert(0, str(ARGS.dependency_path.resolve()))
for variable in ('OMP_NUM_THREADS', 'OPENBLAS_NUM_THREADS', 'MKL_NUM_THREADS'):
    os.environ.setdefault(variable, '2')
import numpy as np
import pandas as pd
import scipy
from scipy.optimize import minimize

QS = np.array([.1, .5, .75, .9])
OUTER = .7324572088988475
SEED = 20260914
EXPERTS = ['extra-trees', 'catboost', 'scaled-catboost', 'spline-ridge', 'weekday-8']
CUSTOM = [
    {'id': 'custom-weekly-daily', 'name': '최종 모델 · 매주 비중 + 매일 보정', 'weights': 'weekly', 'residual': 'daily', 'primary': True},
    {'id': 'custom-daily-daily', 'name': '매일 비중 + 매일 보정', 'weights': 'daily', 'residual': 'daily'},
    {'id': 'custom-residual-only', 'name': '기존 고정 비중 + 매일 보정', 'weights': 'original', 'residual': 'daily'},
    {'id': 'custom-weights-only', 'name': '매주 비중 + 기존 고정 보정자료', 'weights': 'weekly', 'residual': 'original'},
    {'id': 'custom-fixed56', 'name': '56일 고정 비중 + 56일 고정 보정자료', 'weights': 'fixed56', 'residual': 'fixed56'},
    {'id': 'custom-matched-fixed', 'name': '동일 초기조건 · 비중·보정자료 고정', 'weights': 'weekly-initial', 'residual': 'fixed56'},
    {'id': 'custom-matched-residual', 'name': '동일 초기조건 · 보정자료만 매일 갱신', 'weights': 'weekly-initial', 'residual': 'daily'},
    {'id': 'custom-matched-weights', 'name': '동일 초기조건 · 비중만 매주 갱신', 'weights': 'weekly', 'residual': 'fixed56'},
]


def coherent(value):
    q = np.maximum(0, np.asarray(value, dtype=float).copy())
    q[:, 0] = np.minimum(q[:, 0], q[:, 1])
    q[:, 2] = np.maximum(q[:, 2], q[:, 1])
    q[:, 3] = np.maximum(q[:, 3], q[:, 2])
    assert np.isfinite(q).all()
    return q


def shape_features(seq):
    observed = seq[:, :, 1] > 0
    count = observed.sum(axis=1)
    mu = (seq[:, :, 0]*observed).sum(axis=1)/np.maximum(count, 1)
    z = np.where(observed, seq[:, :, 0], mu[:, None])-mu[:, None]
    z /= np.maximum(1, np.sqrt(np.mean(z*z, axis=1)))[:, None]
    power = np.abs(np.fft.rfft(z, axis=1)[:, 1:15])**2
    spectrum = np.sqrt(power/np.maximum(1, power.sum(axis=1))[:, None])
    return np.column_stack([spectrum, z[:, -7:].mean(axis=1), z[:, -14:-7].mean(axis=1)])


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


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def weighted_quantile(values, weights, tau):
    order = np.argsort(values, kind='stable')
    cumulative = np.cumsum(weights[order])/weights.sum()
    return values[order[min(int(np.searchsorted(cumulative, tau)), len(order)-1)]]


class Fold:
    def __init__(self, split, bundle, raw, original_weights):
        self.split = split
        self.bundle = bundle
        self.raw = raw
        self.n = int(bundle['cal_count'])
        self.dates = pd.DatetimeIndex(bundle['dates_eval'])
        self.products = bundle['product_eval']
        self.y = bundle['y_eval'].copy()
        self.experts = np.stack([raw[k] for k in EXPERTS], axis=1)
        columns = bundle['columns'].tolist()
        features = bundle['raw_X_eval']
        a, b = features[:, columns.index('mean28')], features[:, columns.index('median56')]
        self.levels = np.maximum(1, np.where(np.isfinite(a), a, np.where(np.isfinite(b), b, 1)))
        self.shapes = shape_features(bundle['seq_eval'])
        self.original_weights = np.array(original_weights)
        self.weight_cache = {}
        self.weight_audit = []
        self.date_checks = 0
        self.original_residual_start = self.dates[:self.n].min()+pd.Timedelta(days=28)
        self.fixed_et = self.fixed_calibration(raw['extra-trees'])

    def fixed_calibration(self, raw):
        output = raw[self.n:].copy()
        for product in np.unique(self.products):
            rows = np.flatnonzero((self.products == product)&(np.arange(len(self.y)) < self.n))
            offsets = [np.quantile(self.y[rows]-raw[rows, k], tau) for k, tau in enumerate(QS)]
            output[self.products[self.n:] == product] += offsets
        return coherent(output)

    def past_rows(self, date, product=None, window=56, fallback=True):
        past = self.dates < date
        if product is not None:
            past &= self.products == product
        rows = np.flatnonzero(past & (self.dates >= date-pd.Timedelta(days=window)))
        # This matches the documented sparse-product fallback, using only archived
        # out-of-training predictions. No in-sample history is fabricated.
        if product is not None and fallback and len(rows) < 10:
            rows = np.flatnonzero(past)[-56:]
        assert len(rows) and (self.dates[rows] < date).all()
        self.date_checks += 1
        return rows

    def fit_weights(self, date, strategy):
        if strategy == 'original':
            return self.original_weights, np.flatnonzero(self.dates < self.original_residual_start), self.original_residual_start
        cutoff = date-pd.Timedelta(days=date.weekday()) if strategy == 'weekly' else date
        if strategy == 'fixed56':
            cutoff = pd.Timestamp(self.split['testStart'])
        if strategy == 'weekly-initial':
            first = pd.Timestamp(self.split['testStart'])
            cutoff = first-pd.Timedelta(days=first.weekday())
        key = (strategy, str(cutoff.date()))
        if key not in self.weight_cache:
            rows = self.past_rows(cutoff, fallback=False)
            def objective(w):
                point = np.einsum('nmk,m->nk', self.experts[rows], w)
                error = (self.y[rows, None]-point[:, [1, 2]])/self.levels[rows, None]
                tau = np.array([.5, .75])
                return float(np.mean(np.maximum(tau*error, (tau-1)*error))+.01*np.sum((w-.2)**2))
            solution = minimize(objective, np.full(5, .2), method='SLSQP', bounds=[(0, 1)]*5,
                                constraints=[{'type': 'eq', 'fun': lambda w: np.sum(w)-1}],
                                options={'maxiter': 1000, 'ftol': 1e-10})
            assert solution.success, solution.message
            w = solution.x
            assert np.isfinite(w).all() and min(w) >= -1e-7 and abs(w.sum()-1) < 1e-6
            self.weight_cache[key] = (w, rows, cutoff)
            requested_start = cutoff-pd.Timedelta(days=56)
            self.weight_audit.append({'splitId': self.split['id'], 'strategy': strategy,
                'cutoffExclusive': str(cutoff.date()), 'requestedStart': str(requested_start.date()),
                'availableStart': str(self.dates[rows].min().date()),
                'latestOutcome': str(self.dates[rows].max().date()), 'rows': len(rows),
                'shortInitialHistory': bool(requested_start < self.dates.min()),
                'weights': w.tolist(), 'objective': float(solution.fun), 'success': True})
        weights, rows, cutoff = self.weight_cache[key]
        assert (self.dates[rows] < cutoff).all() and cutoff <= date
        return weights, rows, cutoff

    def custom(self, variant, target_dates=None):
        output, updates = [], []
        for index in range(self.n, len(self.y)):
            date, product = self.dates[index], self.products[index]
            if target_dates is not None and date not in target_dates:
                continue
            weights, weight_rows, weight_cutoff = self.fit_weights(date, variant['weights'])
            if variant['residual'] == 'daily':
                rows = self.past_rows(date, product)
            else:
                mask = (np.arange(len(self.y)) < self.n)&(self.products == product)
                if variant['residual'] == 'original':
                    mask &= self.dates >= self.original_residual_start
                rows = np.flatnonzero(mask)
            assert len(rows) and (self.dates[rows] < date).all()
            assert (self.dates[weight_rows] < date).all()
            self.date_checks += 2
            mix_current = np.einsum('mk,m->k', self.experts[index], weights)
            mix_past = np.einsum('nmk,m->nk', self.experts[rows], weights)
            distance = np.sum((self.shapes[rows]-self.shapes[index])**2, axis=1)
            bandwidth = max(.001, float(np.median(distance)))
            similarity = .5+.5*np.exp(-distance/bandwidth)
            residual = (self.y[rows, None]-mix_past)/self.levels[rows, None]
            correction = np.array([self.levels[index]*weighted_quantile(residual[:, k], similarity, tau)
                                   for k, tau in enumerate(QS)])
            ensemble = coherent((mix_current+correction)[None, :])[0]
            result = coherent(((1-OUTER)*self.fixed_et[index-self.n]+OUTER*ensemble)[None, :])[0]
            output.append((index, result))
            updates.append({'variantId': variant['id'], 'splitId': self.split['id'],
                'date': str(date.date()), 'product': int(product), 'weightCutoffExclusive': str(weight_cutoff.date()),
                'weightLatestOutcome': str(self.dates[weight_rows].max().date()), 'weightRows': len(weight_rows),
                'residualFirstOutcome': str(self.dates[rows].min().date()),
                'residualLatestOutcome': str(self.dates[rows].max().date()), 'residualRows': len(rows),
                'newObservedHistoryUsed': bool((rows >= self.n).any()),
                'correctionP50': float(correction[1]), 'correctionP75': float(correction[2]),
                **{f'weight_{k}': float(v) for k, v in zip(EXPERTS, weights)}})
        return output, updates

    def rolling_candidate(self, model_id, target_dates=None):
        raw, output = self.raw[model_id], []
        for index in range(self.n, len(self.y)):
            date = self.dates[index]
            if target_dates is not None and date not in target_dates:
                continue
            rows = self.past_rows(date, self.products[index])
            offset = np.array([np.quantile(self.y[rows]-raw[rows, k], tau) for k, tau in enumerate(QS)])
            output.append((index, coherent((raw[index]+offset)[None, :])[0]))
        return output


def prediction_frame(fold, result, series):
    indices = np.array([x[0] for x in result])
    q = np.array([x[1] for x in result])
    return pd.DataFrame({'seriesId': series['seriesId'], 'variantId': series['variantId'],
        'modelId': series['modelId'], 'group': series['group'], 'splitId': fold.split['id'],
        'date': fold.dates[indices].strftime('%Y-%m-%d'), 'product': fold.products[indices],
        'y': fold.y[indices], 'p50': q[:, 1], 'q75': q[:, 2], 'quantity': quantity(q[:, 2])})


def rows_with_ranks(frame, series):
    scores = [{'seriesId': s['seriesId'], 'variantId': s['variantId'], 'modelId': s['modelId'],
               'group': s['group'], 'name': s['name'], **metrics(frame[frame.seriesId == s['seriesId']])} for s in series]
    for row in scores:
        for group, key in [('fixed', 'rankVsFixed34'), ('rolling', 'rankVsRolling34')]:
            references = [r for r in scores if r['group'] == group and r['modelId'] != 'custom-final']
            assert len(references) == 34
            row[key] = {metric: 1+sum(other[metric] < row[metric]-1e-10 for other in references)
                        for metric in ['loss', 'wape', 'mae']}
    return scores


def paired_bootstrap(frame, first, second, days, seed):
    keys = ['splitId', 'date', 'product']
    a = frame[frame.seriesId == first].set_index(keys).sort_index()
    b = frame[frame.seriesId == second].set_index(keys).sort_index()
    assert a.index.equals(b.index) and np.array_equal(a.y, b.y)
    delta_over = np.maximum(a.quantity-a.y, 0)-np.maximum(b.quantity-b.y, 0)
    delta_under = np.maximum(a.y-a.quantity, 0)-np.maximum(b.y-b.quantity, 0)
    delta = (delta_over+3*delta_under).rename('delta').reset_index()
    samples = np.zeros(1000)
    rng = np.random.default_rng(seed)
    # Resample all products together in overlapping circular calendar-day blocks,
    # separately in each fold, preserving fold sample lengths and omitted dates.
    for split_id, group in delta.groupby('splitId'):
        day_index = pd.date_range(group.date.min(), group.date.max())
        values = group.groupby('date').delta.sum()
        values.index = pd.to_datetime(values.index)
        daily = values.reindex(day_index, fill_value=0).to_numpy(float)
        starts = rng.integers(0, len(daily), size=(1000, int(np.ceil(len(daily)/days))))
        indices = ((starts[:, :, None]+np.arange(days)) % len(daily)).reshape(1000, -1)[:, :len(daily)]
        samples += daily[indices].sum(axis=1)
    low, high = np.percentile(samples, [2.5, 97.5])
    baseline_loss = metrics(b.reset_index())['loss']
    actual_delta = int(delta.delta.sum())
    return {'variantSeriesId': first, 'referenceSeriesId': second, 'blockDays': days,
        'samples': 1000, 'seed': seed, 'lossDelta': actual_delta, 'overDelta': int(delta_over.sum()),
        'underDelta': int(delta_under.sum()), 'weightedUnderDelta': int(3*delta_under.sum()),
        'relativeLossDeltaPercent': float(100*actual_delta/baseline_loss),
        'confidence95': [float(low), float(high)], 'confidenceIncludesZero': bool(low <= 0 <= high),
        'bootstrapProbabilityImprovement': float(np.mean(samples < 0))}


def main(args=ARGS):
    started = time.time()
    prior_predictions_path = args.output.resolve()/'predictions.csv'
    prior_predictions = pd.read_csv(prior_predictions_path, dtype={'date': str}, float_precision='round_trip') if prior_predictions_path.exists() else None
    source = args.source.resolve()
    source_research, source_public = source/'research'/'rebuild', source/'public'/'research'
    baseline = json.loads((source_public/'benchmark.json').read_text(encoding='utf-8'))
    original_provenance = json.loads((source_public/'source-manifest.json').read_text(encoding='utf-8'))
    candidate_models = [m for m in baseline['models'] if m['role'] == 'candidate']
    series = [{'seriesId': 'fixed/'+m['id'], 'variantId': 'frozen', 'modelId': m['id'],
               'name': m['name']+' · 고정 보정', 'group': 'fixed'} for m in baseline['models']]
    series += [{'seriesId': 'rolling/'+m['id'], 'variantId': 'rolling-daily', 'modelId': m['id'],
                'name': m['name']+' · 매일 보정', 'group': 'rolling'} for m in candidate_models]
    series += [{'seriesId': 'custom/'+v['id'], 'variantId': v['id'], 'modelId': 'custom-final',
                'name': v['name'], 'group': 'custom'} for v in CUSTOM]
    original = pd.read_csv(source_public/'predictions.csv', dtype={'date': str})
    fixed = original.copy()
    fixed.insert(0, 'seriesId', 'fixed/'+fixed.modelId)
    fixed.insert(1, 'variantId', 'frozen')
    fixed.insert(3, 'group', 'fixed')
    frames, updates, weight_audit, checks, sources = [fixed], [], [], [], []
    for split in baseline['splits']:
        bundle_path = source_research/(split['id']+'.npz')
        with np.load(bundle_path, allow_pickle=False) as stored:
            bundle = {key: stored[key] for key in stored.files}
        raw = {}
        for model in candidate_models+[{'id': 'scaled-catboost'}]:
            cache = source_research/'cache'/f"{split['id']}-{model['id']}.npz"
            with np.load(cache, allow_pickle=False) as saved:
                assert str(saved['feature_hash']) == split['featureHash']
                assert str(saved['code_signature']) == original_provenance['codeSignature']
                raw[model['id']] = saved['prediction']
                assert raw[model['id']].shape == (len(bundle['y_eval']), 4)
                assert np.isfinite(raw[model['id']]).all()
            sources.append({'path': str(cache.relative_to(source)).replace('\\', '/'), 'sha256': sha(cache)})
        sources.append({'path': str(bundle_path.relative_to(source)).replace('\\', '/'), 'sha256': sha(bundle_path)})
        original_weights = next(r['weights'] for r in baseline['runs'] if r['modelId'] == 'custom-final' and r['splitId'] == split['id'])
        fold = Fold(split, bundle, raw, original_weights)
        outputs = {}
        for variant in CUSTOM:
            result, audit = fold.custom(variant)
            s = next(s for s in series if s['seriesId'] == 'custom/'+variant['id'])
            frames.append(prediction_frame(fold, result, s))
            updates.extend(audit)
            outputs[s['seriesId']] = result
            print(split['id'], variant['id'], metrics(frames[-1]), flush=True)
        for model in candidate_models:
            result = fold.rolling_candidate(model['id'])
            s = next(s for s in series if s['seriesId'] == 'rolling/'+model['id'])
            frames.append(prediction_frame(fold, result, s))
            outputs[s['seriesId']] = result
        # Mutation tests intentionally isolate recalibration from the unchanged base
        # predictions. The archived original verification covers base feature causality.
        test_dates = pd.DatetimeIndex(sorted(set(fold.dates[fold.n:])))
        first_date = test_dates[0]
        initial_reference = np.array([q for i, q in outputs['custom/custom-weekly-daily'] if fold.dates[i] == first_date])
        for matched in ['custom-matched-fixed', 'custom-matched-residual', 'custom-matched-weights']:
            initial_variant = np.array([q for i, q in outputs['custom/'+matched] if fold.dates[i] == first_date])
            np.testing.assert_array_equal(initial_reference, initial_variant)
        selected = sorted(set(test_dates[i] for i in [0, min(2, len(test_dates)-1), len(test_dates)//2, len(test_dates)-1]))
        mutation_cases = 0
        for target in selected:
            changed = Fold(split, bundle, raw, original_weights)
            changed.y[changed.dates >= target] += 123456
            # The ET offsets always use the original pre-test calibration period.
            changed.fixed_et = changed.fixed_calibration(raw['extra-trees'])
            for variant in CUSTOM:
                observed, _ = changed.custom(variant, {target})
                expected = [(i, q) for i, q in outputs['custom/'+variant['id']] if fold.dates[i] == target]
                np.testing.assert_allclose([q for _, q in observed], [q for _, q in expected], rtol=0, atol=1e-9)
                mutation_cases += 1
            for model in candidate_models:
                observed = changed.rolling_candidate(model['id'], {target})
                expected = [(i, q) for i, q in outputs['rolling/'+model['id']] if fold.dates[i] == target]
                np.testing.assert_allclose([q for _, q in observed], [q for _, q in expected], rtol=0, atol=1e-9)
                mutation_cases += 1
        weight_audit.extend(fold.weight_audit)
        checks.append({'splitId': split['id'], 'n': split['n'], 'dateCutoffAssertions': fold.date_checks,
            'matchedFactorialFirstDatePredictionsExactlyEqual': True,
            'mutationTargetDates': [str(d.date()) for d in selected], 'mutationVariantCases': mutation_cases,
            'sameDayAndFutureTargetMutationInvariant': True})
    output = args.output.resolve()
    output.mkdir(parents=True, exist_ok=True)
    predictions = pd.concat(frames, ignore_index=True)
    assert len(series) == 77 and len(predictions) == 77*974
    assert not predictions.duplicated(['seriesId', 'splitId', 'date', 'product']).any()
    assert np.isfinite(predictions[['y', 'p50', 'q75', 'quantity']].to_numpy()).all()
    preserved_previous_series = 0
    if prior_predictions is not None:
        for series_id, old in prior_predictions.groupby('seriesId'):
            new = predictions[predictions.seriesId == series_id]
            keys = ['splitId', 'date', 'product']
            old, new = old.set_index(keys).sort_index(), new.set_index(keys).sort_index()
            assert old.index.equals(new.index)
            # Exact equality is expected: extending the predeclared ablation set
            # must not change any previously computed prediction.
            np.testing.assert_array_equal(old[['y', 'p50', 'q75', 'quantity']].to_numpy(), new[['y', 'p50', 'q75', 'quantity']].to_numpy())
            preserved_previous_series += 1
    predictions.to_csv(output/'predictions.csv', index=False, float_format='%.17g')
    # Every subsequent report is computed from the exported CSV, then independently
    # reconciled with the in-memory predictions and unchanged original fixed scores.
    exported = pd.read_csv(output/'predictions.csv', dtype={'date': str}, float_precision='round_trip')
    aggregate = rows_with_ranks(exported, series)
    keys = ['splitId', 'date', 'product']
    reference = exported[exported.seriesId == 'fixed/custom-final'].set_index(keys).sort_index()
    for s in series:
        persisted = exported[exported.seriesId == s['seriesId']].set_index(keys).sort_index()
        assert persisted.index.equals(reference.index) and np.array_equal(persisted.y, reference.y)
        assert np.array_equal(persisted.quantity.to_numpy(), quantity(persisted.q75.to_numpy()))
        assert (persisted.q75 >= persisted.p50).all() and (persisted.p50 >= 0).all()
        memory = metrics(predictions[predictions.seriesId == s['seriesId']])
        saved = metrics(persisted.reset_index())
        for key in memory:
            assert np.isclose(memory[key], saved[key], atol=1e-8, rtol=1e-11)
    for run in baseline['runs']:
        subset = exported[(exported.seriesId == 'fixed/'+run['modelId'])&(exported.splitId == run['splitId'])]
        saved = metrics(subset)
        for key in ['n', 'actualTotal', 'wape', 'mae', 'over', 'under', 'loss']:
            assert np.isclose(saved[key], run[key], rtol=1e-9, atol=1e-8), (run['id'], key)
    by_split = []
    for split in baseline['splits']:
        by_split.extend([{'splitId': split['id'], **row} for row in rows_with_ranks(exported[exported.splitId == split['id']], series)])
    by_product = []
    for product in baseline['dataset']['products']:
        by_product.extend([{'product': product['id'], 'productName': product['name'], **row}
                           for row in rows_with_ranks(exported[exported['product'] == product['id']], series)])
    primary = 'custom/custom-weekly-daily'
    comparators = ['fixed/custom-final', 'fixed/extra-trees', 'rolling/extra-trees',
        min((r for r in aggregate if r['group'] == 'fixed' and r['modelId'] != 'custom-final'), key=lambda r: r['loss'])['seriesId'],
        min((r for r in aggregate if r['group'] == 'rolling'), key=lambda r: r['loss'])['seriesId'],
        'custom/custom-fixed56', 'custom/custom-residual-only', 'custom/custom-weights-only', 'custom/custom-daily-daily',
        'custom/custom-matched-fixed', 'custom/custom-matched-residual', 'custom/custom-matched-weights']
    pairs = [(primary, reference_id) for reference_id in dict.fromkeys(comparators)]
    pairs += [('custom/custom-matched-residual', 'custom/custom-matched-fixed'),
              ('custom/custom-matched-weights', 'custom/custom-matched-fixed')]
    comparisons = [paired_bootstrap(exported, variant_id, reference_id, days, SEED+days)
                   for variant_id, reference_id in pairs for days in [7, 14]]
    factorial_ids = {'fixed': 'custom/custom-matched-fixed', 'residualOnly': 'custom/custom-matched-residual',
                     'weightsOnly': 'custom/custom-matched-weights', 'both': primary}
    factorial_rows = {name: next(row for row in aggregate if row['seriesId'] == series_id)
                      for name, series_id in factorial_ids.items()}
    factorial_effects = {}
    for metric in ['loss', 'over', 'under', 'wape', 'mae']:
        b, r, w, f = (factorial_rows[name][metric] for name in ['fixed', 'residualOnly', 'weightsOnly', 'both'])
        factorial_effects[metric] = {'residualOnlyDelta': r-b, 'weightsOnlyDelta': w-b,
            'bothDelta': f-b, 'weightsAfterResidualDelta': f-r, 'residualAfterWeightsDelta': f-w,
            'interaction': f-w-r+b}
    factorial = {'description': '2×2 matched-initial-history ablation: same first-week pre-Monday expert weights and same pre-test56-day residual pool; toggle weekly weight updates and daily residual-history updates independently.',
                 'rows': factorial_rows, 'effects': factorial_effects,
                 'interpretation': 'Negative deltas favor the updated setting. Interaction is full minus weights-only minus residual-only plus fixed; descriptive same-observation contrasts, not causal population proof.'}
    pd.DataFrame(updates).to_csv(output/'daily-updates.csv', index=False, float_format='%.17g')
    pd.DataFrame([{**row, **{f'{kind}_{metric}': value for kind in ['rankVsFixed34', 'rankVsRolling34']
                           for metric, value in row[kind].items()}}
                  for row in aggregate]).drop(columns=['rankVsFixed34', 'rankVsRolling34']).to_csv(output/'results.csv', index=False, float_format='%.17g')
    verification = {'status': 'passed', 'series': 77, 'observationsPerSeries': 974,
        'predictionRows': len(exported), 'frozenModelsPreserved': 35, 'dailyCalibratedCandidates': 34,
        'customVariants': 8, 'sameObservationKeysForAllSeries': True, 'duplicatePredictionKeys': 0,
        'previouslyComputedSeriesUnchanged': preserved_previous_series,
        'allFinite': True, 'everyMetricComputedFromExportedCsv': True, 'csvMetricsReconciledWithMemory': True,
        'original35MetricsPreserved': True, 'actualDateCutoffsAssertedForEveryUpdate': True,
        'sameDayAndFutureCalibrationTargetMutationInvariant': True,
        'mutationScope': 'Recalibration only: raw base predictions, lag features and sequences stay fixed; original archived feature-causality verification remains the source for base inputs.',
        'baseModelsRetrained': False, 'checks': checks,
        'originalVerificationSha256': sha(source_public/'verification.json')}
    protocol = {'primaryVariantId': 'custom-weekly-daily', 'expertIds': EXPERTS, 'outerEnsembleWeight': OUTER,
        'weightLoss': 'P50/P75 scale-normalized pinball mean + 0.01*sum((w-0.2)^2); nonnegative weights summing to one',
        'weeklyCutoff': 'Monday 00:00, outcomes strictly before that Monday; previous 56 calendar days across all six products',
        'residualCutoff': 'Strictly before each target date; previous 56 calendar days for the same product, recomputed using current weights; fewer than 10 rows falls back to at most 56 earlier available out-of-training predictions',
        'fixedExtraTrees': 'The external ET branch retains original pre-test 56-day per-product fixed calibration in every custom variant',
        'initialHistory': 'Caches start at each fold calibration start. The first partial week can have fewer than 56 calendar days before Monday; no in-sample predictions are invented.',
        'candidateFairness': 'All 34 candidates use daily per-product residual quantile updates with the same prior-56-calendar-day window and sparse-history rule. Candidate offsets use unweighted residual quantiles; the custom ensemble retains its scale normalization and FFT-similarity weighting. Raw models and coefficients are never retrained.',
        'fixed56Control': 'Uses all pre-test 56 days for both fitting expert weights and residual calibration. These sets overlap; this is a stated control, not a new independent validation set.',
        'originalResidualPool': 'weights-only retains the original last-28-day calibration residual pool; residual-only retains the original first-28-day fitted weights',
        'matchedFactorial': 'matched-fixed, matched-residual, matched-weights and primary use exactly the same initial first-week pre-Monday56-day weights and pre-test56-day residual pool. Only the two subsequent update schedules differ. The initial weight history may be shorter than56 days as explicitly audited.',
        'scoring': 'P50 WAPE and MAE; ceil(P75) with near-integer tolerance 1e-9; loss=over+3*under, inventory0,batch1,no capacity limit',
        'bootstrap': '1000 paired circular calendar-day block samples separately per fold; all products kept together; 7- and 14-day lengths; percentile95% CI; descriptive repeated-data analysis, no multiplicity-adjusted confirmatory claims',
        'variantSelection': 'The primary schedule and first five variants were specified before their rolling scores. After those scores were observed, three matched-initial-condition controls were added to separate mechanisms, with their definitions fixed before scoring those controls. No score-based variant selection or parameter retuning followed.',
        'interpretation': 'Same 974 observations as the frozen rebuilt benchmark. Restores the documented update schedule, not the old 970-observation original experiment or its model checkpoints. This is explanatory analysis of previously explored data, not an untouched confirmatory test.'}
    analysis = {'version': 'bakery-rolling-audit-v1', 'status': 'completed',
        'generatedAt': datetime.now(timezone.utc).isoformat(), 'seed': SEED,
        'primaryVariantId': 'custom-weekly-daily', 'primarySeriesId': primary,
        'dataset': baseline['dataset'], 'splits': baseline['splits'], 'variants': CUSTOM,
        'series': series, 'aggregate': aggregate, 'bySplit': by_split, 'byProduct': by_product,
        'pairedComparisons': comparisons, 'factorial': factorial, 'weeklyWeights': [r for r in weight_audit if r['strategy'] == 'weekly'],
        'weightUpdates': weight_audit, 'protocol': protocol, 'verification': verification,
        'source': {'artifactRunId': '34814876448', 'baseBenchmarkSha256': sha(source_public/'benchmark.json'),
                   'basePredictionsSha256': sha(source_public/'predictions.csv'), 'files': sources,
                   'scriptSha256': sha(Path(__file__)), 'packages': {'numpy': np.__version__, 'pandas': pd.__version__, 'scipy': scipy.__version__}},
        'elapsedSeconds': time.time()-started,
        'artifacts': {name: '/research/rolling/'+name for name in ['analysis.json', 'predictions.csv', 'results.csv', 'methodology.md', 'verification.json', 'daily-updates.csv']}}
    (output/'analysis.json').write_text(json.dumps(analysis, ensure_ascii=False, indent=2, allow_nan=False), encoding='utf-8')
    (output/'verification.json').write_text(json.dumps(verification, ensure_ascii=False, indent=2, allow_nan=False), encoding='utf-8')
    lines = ['# 과거 실적을 날짜마다 반영한 순차 보정 비교', '',
        '기존 35개 고정 결과는 보존하고, 같은 974개 상품·날짜에서 후보34개 일일 보정과 최종 모델8개 변형을 계산했습니다. 기본 모델 재학습은 없습니다.', '',
        '기존 대화의 970개 관측 실험 또는 기존 체크포인트를 재현한 결과가 아닙니다.', '', '## 방법', '']
    lines.extend('- **'+key+'**: '+value for key, value in protocol.items() if isinstance(value, str))
    lines += ['', '## 전체 결과', '', '| 방식 | WAPE | MAE | 과다 | 부족 | 과다+3×부족 | 고정34개 대비 순위 | 일일보정34개 대비 순위 |', '|---|---:|---:|---:|---:|---:|---:|---:|']
    for row in aggregate:
        if row['group'] == 'custom' or row['seriesId'] in ['fixed/custom-final', 'fixed/extra-trees', 'rolling/extra-trees']:
            lines.append(f"| {row['name']} | {row['wape']:.4f}% | {row['mae']:.4f} | {row['over']} | {row['under']} | {row['loss']} | {row['rankVsFixed34']['loss']} | {row['rankVsRolling34']['loss']} |")
    lines += ['', '## 검증', '', json.dumps(verification, ensure_ascii=False, indent=2)]
    (output/'methodology.md').write_text('\n'.join(lines)+'\n', encoding='utf-8')
    print(json.dumps({'status': 'completed', 'output': str(output), 'primary': next(r for r in aggregate if r['seriesId'] == primary), 'verification': verification, 'elapsedSeconds': time.time()-started}, ensure_ascii=True), flush=True)


if __name__ == '__main__':
    main()
