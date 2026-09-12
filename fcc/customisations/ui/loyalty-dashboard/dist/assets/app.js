/* Fieldstone Rewards — the tier ladder, as a shopper sees it.
   Built by the Fieldstone team; served by the platform on an origin of its own.

   There is deliberately no shopper here. The frame's address is public — it is
   in a referrer, a history and a screenshot — so the platform sends only facts
   about the PAGE. Anything about a person, this app asks Fieldstone's own
   service for, on its own origin, having authenticated them itself. */
(function () {
  "use strict";

  var TIERS = [
    { key: "silver", name: "Silver", from: 0, blurb: "Free returns within 30 days on every order." },
    { key: "gold", name: "Gold", from: 5000, blurb: "Free next-day delivery, and early access to sale events." },
    { key: "platinum", name: "Platinum", from: 20000, blurb: "A dedicated line, and double points every weekend." }
  ];

  var params = new URLSearchParams(window.location.search);
  var shop = params.get("tenantSlug") || "Fieldstone";
  var locale = params.get("locale") || "en";

  /* The credential the platform hands us, once, by postMessage.
     Never in the URL — a URL turns up in a referrer, a history and a
     screenshot. We hold it in a closure and send it with our own calls. */
  var credential = null;
  var balance = null;

  /* Our own function, running in their sandbox, reading our own ledger.
     We declared it in fcc.json when we built; asking for anything else is
     refused, which is the point. */
  function loadBalance() {
    if (!credential) return;
    fetch("/__fcc/call/points-balance", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + credential },
      body: "{}"
    })
      .then(function (r) {
        /* 401 is the credential, not us. Renew and try once more — a
           dashboard is the kind of page somebody leaves open, and ours was
           going quiet after fifteen minutes with nothing on screen saying so. */
        if (r.status === 401) return renew().then(function (ok) { return ok ? loadBalance() : null; });
        return r.ok ? r.json() : null;
      })
      .then(function (data) { if (data) { balance = data; render(); } })
      .catch(function () { /* The ladder still renders. A balance we cannot
                              fetch is a quieter screen, not a broken one. */ });
  }

  /* A fresh credential from the one we hold. The platform bounds how long this
     can go on; when it says reload, we reload rather than sitting there. */
  function renew() {
    return fetch("/__fcc/renew", {
      method: "POST",
      headers: { Authorization: "Bearer " + credential }
    })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (body) {
        if (body && body.token) { credential = body.token; return true; }
        location.reload();
        return false;
      })
      .catch(function () { return false; });
  }

  /* Ahead of expiry rather than after it. The credential lasts fifteen
     minutes; renewing at twelve means a shopper reading the page never sees a
     gap, and never finds out this mechanism exists. */
  setInterval(function () { if (credential) renew(); }, 12 * 60 * 1000);

  function render() {
    var app = document.getElementById("app");
    var current = balance ? balance.tier : null;

    var html =
      '<div class="wrap">' +
      "<h1>Fieldstone Rewards</h1>" +
      (balance && !balance.anonymous
        ? '<p class="balance"><strong>' + Number(balance.points).toLocaleString(locale) +
          " points</strong> &middot; " + current + " member</p>"
        : '<p class="sub">Every order earns points. Points move you up the ladder, and the ladder never resets.</p>') +
      '<ul class="ladder">';

    TIERS.forEach(function (t) {
      /* The tier we are actually on, when we know it. Before the balance
         arrives nothing is highlighted — a guess would be wrong for most
         people looking at it. */
      html +=
        '<li class="tier' + (t.key === current ? " is-current" : "") + '">' +
        '<span class="badge">' + t.name + "</span>" +
        "<div><h2>" + t.from.toLocaleString(locale) + " points</h2>" +
        "<p>" + t.blurb + "</p></div></li>";
    });

    if (balance && balance.entries && balance.entries.length) {
      html += '<h3 class="recent">Recent</h3><ul class="entries">';
      balance.entries.forEach(function (e) {
        html +=
          "<li><span>" + (e.reason || "Points") + "</span>" +
          '<span class="pts">' + (e.points > 0 ? "+" : "") + e.points + "</span></li>";
      });
      html += "</ul>";
    }

    html +=
      "</ul>" +
      '<p class="foot">Operated by Fieldstone for ' + shop.replace(/[^a-z0-9- ]/gi, "") + ".</p>" +
      "</div>";
    app.innerHTML = html;
    app.setAttribute("aria-busy", "false");
    reportHeight();
  }

  /* Our height, which the platform caps — an app reporting 200,000 pixels has
     a bug, and the page it sits in should not be 200,000 pixels tall while
     somebody fixes it. */
  function reportHeight() {
    parent.postMessage({ type: "fcc:height", height: document.documentElement.scrollHeight }, "*");
  }

  /* Answering `fcc:measure` is the part that matters.
     We load before the platform's slot does — that is deliberate on their side,
     so their page is usable first — which means our announcement below is sent
     into a page with nobody listening yet. They ask once they are ready. */
  window.addEventListener("message", function (e) {
    if (!e.data) return;
    if (e.data.type === "fcc:measure") reportHeight();
    if (e.data.type === "fcc:credential" && !credential) {
      credential = e.data.token;
      loadBalance();
    }
  });

  render();
  reportHeight();
  window.addEventListener("resize", reportHeight);
})();
