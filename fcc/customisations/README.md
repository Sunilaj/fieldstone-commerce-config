# Commerce configuration

Written by Flipkart Commerce Cloud. Everything under `fcc/customisations/` is generated
from the tenant on each publish.

    functions/<name>.js          the code a rule runs
    functions/<name>.meta.json   its trigger, tier and whether it is on
    agents/<slug>/prompt.md      an agent's system prompt
    agents/<slug>/evals.json     the cases it must pass to earn autonomy
    agents/<slug>/agent.json     its tools, triggers, risk tier and model card
    workflows/<name>.json        multi-agent orchestrations
    roles/<name>.json            a role and the service permissions on it
    flags/<key>.json             a feature-flag override
    branding.json                colour and logo
    packages/<key>/<version>.fccpkg.json
                                 the assembled, checksummed release

## Editing these files does not change the platform

They are written by it, for reading and reviewing. What changes a tenant is
IMPORTING a package, and the package is regenerated from the platform on every
publish — so an edit made here is overwritten by the next one.

Review changes here; make changes in the platform.

## Importing lands a draft

A package that arrives in a tenant is a draft. Somebody still has to activate
it, and activation records what it replaced so it can be reverted. A merge here
is not a deployment.
