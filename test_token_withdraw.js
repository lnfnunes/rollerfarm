'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function loadTestApi() {
    const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
    const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
    const fakeElement = () => ({
        style: {},
        dataset: {},
        classList: { toggle() {} },
        setAttribute() {},
        addEventListener() {},
        focus() {},
        querySelector: () => fakeElement(),
        querySelectorAll: () => [],
    });
    const window = {
        __WITHDRAW_RADAR_TEST__: true,
        localStorage: { getItem: () => null, setItem() {} },
    };
    const context = {
        window,
        document: {
            getElementById: () => fakeElement(),
            querySelector: () => fakeElement(),
            querySelectorAll: () => [],
        },
        Intl,
    };
    vm.runInNewContext(script, context);
    return window.__withdrawRadarTestApi;
}

const api = loadTestApi();

// payoutAmount / scale = tokens per block; duration 86400s => one block per day.
function currency(name, tokensPerDay, totalPower, scale) {
    return { name, payoutAmount: tokensPerDay * scale, totalPower, duration: 86400 };
}

// Single coin: P / (T_next + P) * R_next = D_current  =>  P = D * T / (R - D)
{
    const current = { id: 'd3', title: 'Diamond III', minPower: 10, currencies: [currency('BNB_SMALL', 1, 100, 1e10)] };
    const next = { id: 'd2', title: 'Diamond II', minPower: 20, currencies: [currency('BNB_SMALL', 2, 1000, 1e10)] };
    const target = api.calculateNextLeagueTarget(current, next, 10, { BNB: 600 });
    // Current daily = 1 * 10/100 = 0.1 BNB; required = 0.1 * 1000 / (2 - 0.1)
    assert.ok(Math.abs(target.powerGh - 100 / 1.9) < 1e-9);
    assert.ok(Math.abs(target.deltaGh - (100 / 1.9 - 10)) < 1e-9);
    assert.deepEqual([...target.symbols], ['BNB']);
    assert.ok(Math.abs(target.dailyUsd - 60) < 1e-9);
}

// Averages required power of the top 5 coins by current daily USD, ignoring the rest.
{
    const current = {
        id: 'a', minPower: 0, currencies: [
            currency('BNB_SMALL', 1, 100, 1e10),
            currency('ETH_SMALL', 1, 100, 1e10),
            currency('SOL_SMALL', 1, 100, 1e9),
            currency('LTC_SMALL', 1, 100, 1e8),
            currency('XRP_SMALL', 1, 100, 1e6),
            currency('DOGE_SMALL', 1, 100, 1e4),
        ],
    };
    const next = {
        id: 'b', minPower: 1, currencies: [
            currency('BNB_SMALL', 2, 1000, 1e10),
            currency('ETH_SMALL', 1.1, 100, 1e10),
            currency('SOL_SMALL', 0.2, 100, 1e9),
            currency('LTC_SMALL', 0.2, 100, 1e8),
            currency('XRP_SMALL', 1.1, 100, 1e6),
            currency('DOGE_SMALL', 100, 1, 1e4),
        ],
    };
    const prices = { BNB: 600, ETH: 3000, SOL: 150, LTC: 80, XRP: 2, DOGE: 0.1 };
    const target = api.calculateNextLeagueTarget(current, next, 10, prices);
    const bnb = 0.1 * 1000 / (2 - 0.1);
    const eth = 0.1 * 100 / (1.1 - 0.1);
    const sol = 0.1 * 100 / (0.2 - 0.1);
    const ltc = 0.1 * 100 / (0.2 - 0.1);
    const xrp = 0.1 * 100 / (1.1 - 0.1);
    assert.deepEqual([...target.symbols].sort(), ['BNB', 'ETH', 'LTC', 'SOL', 'XRP']);
    assert.ok(Math.abs(target.powerGh - (bnb + eth + sol + ltc + xrp) / 5) < 1e-9);
}

// Never below the next league entry threshold.
{
    const current = { id: 'a', minPower: 0, currencies: [currency('BNB_SMALL', 1, 100, 1e10)] };
    const next = { id: 'b', minPower: 500, currencies: [currency('BNB_SMALL', 10, 100, 1e10)] };
    const target = api.calculateNextLeagueTarget(current, next, 10, { BNB: 600 });
    assert.equal(target.powerGh, 500);
}

// Next league pool too small to ever match => no finite target.
{
    const current = { id: 'a', minPower: 0, currencies: [currency('BNB_SMALL', 1, 100, 1e10)] };
    const next = { id: 'b', minPower: 1, currencies: [currency('BNB_SMALL', 0.05, 100, 1e10)] };
    const target = api.calculateNextLeagueTarget(current, next, 10, { BNB: 600 });
    assert.equal(target.powerGh, Infinity);
}

// Without prices, top coins cannot be ranked.
{
    const current = { id: 'a', minPower: 0, currencies: [currency('BNB_SMALL', 1, 100, 1e10)] };
    const next = { id: 'b', minPower: 1, currencies: [currency('BNB_SMALL', 2, 1000, 1e10)] };
    assert.equal(api.calculateNextLeagueTarget(current, next, 10, {}), null);
}

// Farm history: one snapshot per day; the same day is overwritten by the latest refresh.
{
    let history = api.recordFarmSnapshot({}, '2026-10-29', { BTC: 1, ETH: 2 });
    history = api.recordFarmSnapshot(history, '2026-10-30', { BTC: 3 });
    history = api.recordFarmSnapshot(history, '2026-10-30', { BTC: 4, ETH: 5 });
    assert.deepEqual(JSON.parse(JSON.stringify(history)), {
        '2026-10-29': { BTC: 1, ETH: 2 },
        '2026-10-30': { BTC: 4, ETH: 5 },
    });
}

// Farm history keeps only the 15 most recent days.
{
    let history = {};
    for (let day = 1; day <= 20; day++) {
        const key = '2026-10-' + String(day).padStart(2, '0');
        history = api.recordFarmSnapshot(history, key, { BTC: day });
    }
    const keys = Object.keys(history).sort();
    assert.equal(keys.length, 15);
    assert.equal(keys[0], '2026-10-06');
    assert.equal(keys[14], '2026-10-20');
}

// Series covers 15 consecutive days ending today; days without a snapshot are gaps (null).
{
    const history = {
        '2026-10-28': { BTC: 1, ETH: 2 },
        '2026-10-30': { BTC: 3 },
        '2026-09-01': { SOL: 9 }, // outside the window
    };
    const view = api.buildFarmSeries(history, '2026-10-30');
    assert.equal(view.dates.length, 15);
    assert.equal(view.dates[0], '2026-10-16');
    assert.equal(view.dates[14], '2026-10-30');
    // Days 10-27..10-30
    assert.deepEqual([...view.series.BTC.slice(11)], [null, 1, null, 3]);
    // Days 10-28..10-30
    assert.deepEqual([...view.series.ETH.slice(12)], [2, null, null]);
    assert.deepEqual(Object.keys(view.series).sort(), ['BTC', 'ETH']);
}

// Month boundaries are handled when walking back from the end date.
{
    const view = api.buildFarmSeries({}, '2026-03-05');
    assert.equal(view.dates[0], '2026-02-19');
    assert.equal(view.dates[14], '2026-03-05');
}

// Series can be read as USD or token amount; legacy snapshots (plain USD numbers) have no amount.
{
    const history = {
        '2026-10-29': { BTC: 5 },
        '2026-10-30': { BTC: { usd: 6, amount: 0.0001 }, ETH: { usd: 2, amount: 0.001 } },
    };
    const usd = api.buildFarmSeries(history, '2026-10-30', 'usd');
    assert.deepEqual([...usd.series.BTC.slice(13)], [5, 6]);
    assert.deepEqual([...usd.series.ETH.slice(13)], [null, 2]);
    const amount = api.buildFarmSeries(history, '2026-10-30', 'amount');
    assert.deepEqual([...amount.series.BTC.slice(13)], [null, 0.0001]);
    assert.deepEqual([...amount.series.ETH.slice(13)], [null, 0.001]);
}

// Saved chart view: invalid input falls back to USD with every token visible.
{
    const defaults = { metric: 'usd', hidden: [] };
    assert.deepEqual(JSON.parse(JSON.stringify(api.normalizeFarmView(null))), defaults);
    assert.deepEqual(JSON.parse(JSON.stringify(api.normalizeFarmView('x'))), defaults);
    assert.deepEqual(JSON.parse(JSON.stringify(api.normalizeFarmView({ metric: 'eur', hidden: 'BTC' }))), defaults);
    const view = api.normalizeFarmView({ metric: 'amount', hidden: ['BTC', 'FOO', 'BTC', 'ETH'] });
    assert.equal(view.metric, 'amount');
    assert.deepEqual([...view.hidden].sort(), ['BTC', 'ETH']);
}

// Toggling a token hides it, toggling again shows it; the input is not mutated.
{
    const hidden = ['BTC'];
    assert.deepEqual([...api.toggleFarmSymbol(hidden, 'ETH')].sort(), ['BTC', 'ETH']);
    assert.deepEqual([...api.toggleFarmSymbol(hidden, 'BTC')], []);
    assert.deepEqual(hidden, ['BTC']);
}

console.log('token_withdraw tests passed');
