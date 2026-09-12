# Fieldstone Rewards

Fieldstone's own loyalty scheme. Points earned on paid orders, redeemed at checkout. Built by Fieldstone on the platform APIs.

A service this tenant runs, bound into the commerce flow. **Its source is not in
this directory** — the platform records that the binding exists and what it is
allowed to do; the code belongs to whoever wrote the service.

| | |
|---|---|
| Version accepted | `1.4.0` |
| Called synchronously at | `http://localhost:4500` |
| Address | this tenant's own instance |
| Told about events at | `http://localhost:4500/hooks/fcc` |
| Contributes to | checkout |
| Subscribed events | order.placed |
| Scopes granted | order-management:view |

Editing this file does not change the platform. Importing the package that
carries it creates a draft that somebody still has to activate.
