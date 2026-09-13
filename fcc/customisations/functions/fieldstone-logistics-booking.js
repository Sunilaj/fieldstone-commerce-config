// Books the van and writes the promise onto the order, so fulfilment sees
// what the shopper was actually sold rather than inferring it from a total.
var chosen = input.fulfilment;
if (!chosen || !chosen.id) return {};

function dayKey(d) {
  return d.getFullYear() + '-' +
    String(d.getMonth() + 1).padStart(2, '0') + '-' +
    String(d.getDate()).padStart(2, '0');
}

var day = dayKey(new Date());

// Keyed on the ORDER. The money has already moved by the time this runs, so
// it can be called again after a retry — and a key derived from anything
// else (a timestamp, a counter) would be a second van for one delivery.
var booked = { written: false, reason: 'store unavailable' };
try {
  booked = await host.storage.put(
    'delivery-slots',
    'booked:' + day + ':' + chosen.id + ':' + input.orderId,
    {
      orderId: input.orderId,
      slot: chosen.id,
      label: chosen.label,
      surchargeMinor: chosen.surchargeMinor,
      currency: input.currency,
      at: new Date().toISOString()
    }
  );
} catch (e) {
  console.error('delivery-slots: could not book ' + chosen.id + ' — ' + e.message);
}

// The attributes go on the order whether or not the van was reserved. A
// shopper who paid a surcharge is owed a record of what for, and 'no' here
// is what tells a dispatcher to look rather than to assume.
return {
  attributes: {
    'delivery-slot': String(chosen.label || chosen.id),
    'delivery-slot-id': String(chosen.id),
    'delivery-surcharge-minor': String(chosen.surchargeMinor || 0),
    'delivery-currency': String(input.currency || ''),
    'delivery-booked': booked && booked.written ? 'yes' : 'no'
  }
};
