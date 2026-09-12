# Fieldstone Rewards

Fieldstone's own loyalty scheme. **This is not part of Flipkart Commerce Cloud.**
It is a separate service, in a separate repository, run by Fieldstone, built
against the platform's public APIs — and it is the example of the third kind of
extensibility the platform supports:

| Where a developer works | Their code runs | Example |
|---|---|---|
| Inside the platform | our sandbox | a Studio function, a custom agent |
| On the marketplace | the publisher's infrastructure | an ISV's delivery-slot extension |
| **Alongside, on the APIs** | **their own infrastructure** | **this** |

## What it does that the platform does not

Points. There is no loyalty service in the platform's catalogue of twenty-five
and there should not be: every retailer's scheme is different, and a generic one
would be wrong for all of them. Fieldstone earns a point per rupee on paid
orders and lets a shopper redeem 100 points for ₹100 off at checkout.

## How it reaches a core flow

The platform lets an installed extension CONTRIBUTE to checkout. Fieldstone's
install declares `contributes: ["checkout"]` and an `apiUrl`, and the platform
then asks this service, while the shopper waits:

    POST /checkout/offers   → what can this shopper have off this basket?
    POST /checkout/redeem   → they chose it; is it still good?

`offers` is a quotation. `redeem` is binding, and this service may refuse —
the points may have been spent on another order in between.

## The boundaries, from this side

- It never runs on the platform. The platform calls it over HTTP and nothing of
  Fieldstone's executes in the platform's process.
- It sees **one tenant's** basket, and only what the request carries: a tenant
  id, a shopper id, a subtotal and a currency. No catalogue, no other tenants,
  no other shoppers.
- Every request is a signed token from the platform, verified here against the
  platform's JWKS with audience `fcc-extension`. An unsigned request is refused:
  this service gives away money on the strength of it.
- It is not trusted back. The platform caps any discount at the basket
  subtotal, drops an offer in another currency, and abandons the call if this
  service is slow — a shopper can still buy when Fieldstone's own loyalty
  service is down.

## Running it

    npm install
    PORT=4500 FCC_PLATFORM_URL=http://localhost:3000 npm start
