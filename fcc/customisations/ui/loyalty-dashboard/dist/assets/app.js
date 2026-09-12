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

  function render() {
    var app = document.getElementById("app");
    var html =
      '<div class="wrap">' +
      "<h1>Fieldstone Rewards</h1>" +
      '<p class="sub">Every order earns points. Points move you up the ladder, and the ladder never resets.</p>' +
      '<ul class="ladder">';

    TIERS.forEach(function (t) {
      html +=
        '<li class="tier' + (t.key === "silver" ? " is-current" : "") + '">' +
        '<span class="badge">' + t.name + "</span>" +
        "<div><h2>" + t.from.toLocaleString(locale) + " points</h2>" +
        "<p>" + t.blurb + "</p></div></li>";
    });

    html +=
      "</ul>" +
      '<p class="foot">Operated by Fieldstone for ' + shop.replace(/[^a-z0-9- ]/gi, "") + ".</p>" +
      "</div>";
    app.innerHTML = html;
    app.setAttribute("aria-busy", "false");
  }

  /* The frame's height, asked for rather than assumed.
     The platform caps whatever is sent — an app reporting 200,000 pixels has a
     bug, and the page it sits in should not be 200,000 pixels tall while
     somebody fixes it. */
  function reportHeight() {
    var h = document.documentElement.scrollHeight;
    parent.postMessage({ type: "fcc:height", height: h }, "*");
  }

  render();
  reportHeight();
  window.addEventListener("resize", reportHeight);
})();
