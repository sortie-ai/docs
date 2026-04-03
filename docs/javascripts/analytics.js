(function () {
  "use strict";

  const MEASUREMENT_ID = "G-58VR448EJK";
  const GTAG_URL = "https://www.googletagmanager.com/gtag/js";

  // Initialize the command queue before anything else.
  // gtag() pushes commands onto the queue; when gtag.js loads it drains it.
  window.dataLayer = window.dataLayer || [];
  function gtag() {
    window.dataLayer.push(arguments);
  }
  // Expose globally so cookieconsent-config.js can call gtag() for consent updates.
  window.gtag = gtag;

  // Consent Mode v2: deny analytics by default before any tags fire.
  // wait_for_update gives CookieConsent up to 500 ms to call gtag("consent", "update", ...)
  // before GA4 sends the first hit. This covers returning visitors whose consent
  // cookie is read synchronously on page load.
  gtag("consent", "default", {
    analytics_storage: "denied",
    wait_for_update: 500,
  });

  // Required gtag.js initialization timestamp.
  gtag("js", new Date());

  // Configure the GA4 property.
  // cookie_expires: 6 months instead of the GA4 default of 2 years.
  // cookie_flags: SameSite=Lax is correct for a first-party site.
  gtag("config", MEASUREMENT_ID, {
    cookie_expires: 182 * 24 * 60 * 60,
    cookie_flags: "SameSite=Lax",
  });

  // Inject gtag.js dynamically. Because this runs after the queue is already
  // populated with the consent default and config commands, gtag.js will always
  // process them in the correct order — no race condition possible.
  const script = document.createElement("script");
  script.src = `${GTAG_URL}?id=${MEASUREMENT_ID}`;
  script.async = true;
  document.head.appendChild(script);

  // Track clicks on outbound links.
  // Uses navigator.sendBeacon() via transport_type:"beacon" so the hit is
  // delivered even when the click navigates away from the page immediately.
  // Uses closest("a") to handle clicks on child elements inside a link tag.
  // GA4 Consent Mode will suppress the event if analytics_storage is denied.
  function trackOutboundLink(url, opensInNewTab) {
    gtag("event", "click", {
      event_label: url,
      event_category: "outbound",
      transport_type: "beacon",
      event_callback: () => {
        if (!opensInNewTab) {
          document.location = url;
        }
      },
    });
  }

  document.addEventListener(
    "click",
    (event) => {
      const el = event.target.closest("a");
      if (!el || el.host === window.location.host) return;
      trackOutboundLink(el.href, el.getAttribute("target") === "_blank");
    },
    false,
  );
})();
