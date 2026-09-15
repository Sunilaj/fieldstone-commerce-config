// Fieldstone's own delivery promises. Runs in the platform's sandbox:
// no network, no credential, and nothing to read but what it asked for.
var DEFAULTS = {
  currency: 'INR',
  sameDaySurchargeMinor: 24900,
  nextDaySurchargeMinor: 9900,
  sameDayCapacity: 40,
  cutOffHour: 22
};

// The LOCAL date, never the ISO one. `toISOString()` is UTC, and a UTC key
// with a local cut-off starts booking tomorrow's van at half past six in
// the evening in Bengaluru — on a day the shopper is still standing in.
function dayKey(d) {
  return d.getFullYear() + '-' +
    String(d.getMonth() + 1).padStart(2, '0') + '-' +
    String(d.getDate()).padStart(2, '0');
}

// A store that cannot be reached is not a checkout that cannot be used.
// Every read here falls back, because the alternative is a handler that
// throws and takes the whole delivery section down with it.
async function orElse(promise, fallback) {
  try { var v = await promise; return v === null || v === undefined ? fallback : v; }
  catch (e) { console.warn('delivery-slots: store unavailable — ' + e.message); return fallback; }
}

var stored = await orElse(host.storage.get('delivery-slots', 'config'), {});
var cfg = Object.assign({}, DEFAULTS, stored);

var now = new Date();
var today = dayKey(now);

// Zero is zero in every currency, so the free promise is always safe to
// make. Everything with a price on it is quoted only in the currency this
// price book is written in — never converted, because a rate invented
// inside a checkout is a charge nobody stands behind.
var options = [{
  id: 'standard',
  label: 'Standard delivery',
  detail: 'Three to five working days',
  surchargeMinor: 0,
  currency: input.currency
}];

if (input.currency !== cfg.currency) {
  console.log('delivery-slots: basket in ' + input.currency + ', prices in ' + cfg.currency + ' — free options only');
  return { options: options };
}

options.unshift({
  id: 'next-day',
  label: 'Next-day delivery',
  detail: 'With you before 6pm tomorrow',
  surchargeMinor: cfg.nextDaySurchargeMinor,
  currency: cfg.currency
});

// The van has to exist before it is sold. Counted out of the same namespace
// the booking handler writes into — if those two ever disagree the count is
// always zero, capacity never falls, and this reads as healthy for ever.
if (now.getHours() < cfg.cutOffHour) {
  var booked = await orElse(
    host.storage.list('delivery-slots', { prefix: 'booked:' + today + ':same-day:', limit: 200 }),
    []
  );
  if (booked.length < cfg.sameDayCapacity) {
    options.unshift({
      id: 'same-day',
      label: 'Same-day delivery',
      detail: 'Ordered before ' + cfg.cutOffHour + ':00 — on your doorstep tonight',
      surchargeMinor: cfg.sameDaySurchargeMinor,
      currency: cfg.currency
    });
  } else {
    console.log('delivery-slots: same-day full for ' + today + ' (' + booked.length + ' booked)');
  }
}

return { options: options };
