(function () {
  "use strict";

  const MEASUREMENT_ID = "G-58VR448EJK";
  const GTAG_URL = "https://www.googletagmanager.com/gtag/js";

  // ---------------------------------------------------------------------------
  // GA4 initialization
  // ---------------------------------------------------------------------------

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

  // ---------------------------------------------------------------------------
  // Outbound link tracking
  // Uses navigator.sendBeacon() via transport_type:"beacon" so the hit is
  // delivered even when the click navigates away from the page immediately.
  // Uses closest("a") to handle clicks on child elements inside a link tag.
  // GA4 Consent Mode will suppress the event if analytics_storage is denied.
  // ---------------------------------------------------------------------------

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

  // ---------------------------------------------------------------------------
  // Code copy tracking
  // copy-button.js (loaded after this script) injects <button> elements into
  // every .hextra-code-copy-btn. Event delegation on document captures those clicks
  // regardless of when the buttons are added to the DOM.
  // ---------------------------------------------------------------------------

  document.addEventListener(
    "click",
    (event) => {
      if (!event.target.closest(".hextra-code-copy-btn")) return;
      gtag("event", "code_copy", {
        page_location: window.location.pathname,
      });
    },
    false,
  );

  // ---------------------------------------------------------------------------
  // Site search tracking
  // Hextra v0.12.1 renders <input class="hextra-search-input" ...> inside
  // <div class="hextra-search-wrapper"> in layouts/_partials/search.html
  // <dialog id="search-dialog">. We attach a debounced listener alongside the
  // theme's own oninput handler — both coexist without interference.
  // Fires only after 500 ms of inactivity and at least 3 characters to avoid
  // sending every intermediate keystroke.
  // ---------------------------------------------------------------------------

  const searchInput = document.querySelector("input.hextra-search-input");
  if (searchInput) {
    let searchDebounceTimer;
    searchInput.addEventListener("input", (event) => {
      clearTimeout(searchDebounceTimer);
      const query = event.target.value.trim();
      if (query.length < 3) return;
      searchDebounceTimer = setTimeout(() => {
        gtag("event", "search", { search_term: query });
      }, 500);
    });
  }

  // ---------------------------------------------------------------------------
  // 404 page tracking
  // PerformanceNavigationTiming.responseStatus reflects the actual HTTP status
  // code without an additional network request. Supported in all modern browsers.
  // Sends the page URL and referrer so broken links can be traced to their source.
  // ---------------------------------------------------------------------------

  const navEntry = performance.getEntriesByType("navigation")[0];
  if (navEntry?.responseStatus === 404) {
    gtag("event", "page_not_found", {
      page_location: window.location.href,
      page_referrer: document.referrer,
    });
  }

  // ---------------------------------------------------------------------------
  // Scroll depth tracking — 25 / 50 / 75 / 90 %
  // Throttled with requestAnimationFrame so the handler runs at most once per
  // browser repaint (~60 fps) instead of hundreds of times per second.
  // passive:true signals that preventDefault() is never called, enabling
  // browser scroll-performance optimizations.
  // Each milestone fires only once per page load (firedMilestones guards this).
  //
  // If GA4 Enhanced Measurement is enabled in your property, it independently
  // fires a "scroll" event at ~90 %. Disable it under:
  // Admin → Data Streams → Enhanced Measurement → Scrolls
  // to avoid double-counting the 90% milestone.
  // ---------------------------------------------------------------------------

  const SCROLL_MILESTONES = [25, 50, 75, 90];
  const firedMilestones = new Set();
  let scrollRaf = null;

  function handleScroll() {
    if (scrollRaf) return;
    scrollRaf = requestAnimationFrame(() => {
      scrollRaf = null;

      const scrolled = window.scrollY;
      const total = document.documentElement.scrollHeight - window.innerHeight;
      if (total <= 0) return;

      const percent = Math.round((scrolled / total) * 100);

      for (const milestone of SCROLL_MILESTONES) {
        if (!firedMilestones.has(milestone) && percent >= milestone) {
          firedMilestones.add(milestone);
          gtag("event", "scroll_depth", { percent_scrolled: milestone });
        }
      }
    });
  }

  window.addEventListener("scroll", handleScroll, { passive: true });
})();
