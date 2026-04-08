/**
 * Version announcement banner
 *
 * Shows a dismissible banner when the site's latest release (embedded at
 * build time via data-version on #sortie-version-banner) is newer than
 * the version the visitor last acknowledged, stored in a functional cookie.
 *
 * Cookie: sortie_version_seen  (Necessary / Functional, 1 year)
 *   Persists the last release the user has seen so the banner is suppressed
 *   on subsequent visits for the same or older versions.  This is a
 *   preference cookie, not a tracking cookie, and therefore lives in the
 *   "Strictly necessary" category of the cookie consent dialog.
 *
 * GA4 events emitted:
 *   version_banner_shown   – banner was revealed on this page load
 *   version_banner_clicked – visitor clicked the "what's new" link
 *   version_banner_closed  – visitor dismissed the banner via the × button
 *
 * Analytics hits respect Consent Mode v2: if the visitor has not granted
 * analytics_storage, gtag.js will discard the hits automatically.
 */
(function () {
  "use strict";

  var COOKIE_NAME = "sortie_version_seen";
  var COOKIE_MAX_AGE = 365 * 24 * 60 * 60; // one year, in seconds

  // ---------------------------------------------------------------------------
  // Cookie helpers
  // ---------------------------------------------------------------------------

  function getCookie(name) {
    var escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    var match = document.cookie.match(
      new RegExp("(?:^|; )" + escaped + "=([^;]*)"),
    );
    return match ? decodeURIComponent(match[1]) : null;
  }

  function setCookie(name, value) {
    document.cookie = [
      name + "=" + encodeURIComponent(value),
      "max-age=" + COOKIE_MAX_AGE,
      "path=/",
      "SameSite=Lax",
    ].join("; ");
  }

  // ---------------------------------------------------------------------------
  // Semantic version comparison — supports "major.minor.patch"
  // ---------------------------------------------------------------------------

  function parseVersion(v) {
    return String(v || "0.0.0")
      .split(".")
      .slice(0, 3)
      .map(function (n) {
        return parseInt(n, 10) || 0;
      });
  }

  /**
   * Returns true when `candidate` is strictly newer than `baseline`.
   * Comparison is numerical, left-to-right (major → minor → patch).
   */
  function isNewer(candidate, baseline) {
    var c = parseVersion(candidate);
    var b = parseVersion(baseline);
    for (var i = 0; i < 3; i++) {
      if (c[i] > b[i]) return true;
      if (c[i] < b[i]) return false;
    }
    return false; // versions are equal
  }

  // ---------------------------------------------------------------------------
  // Layout helper — keeps Hextra's sidebar top-offset in sync with the banner
  // ---------------------------------------------------------------------------

  /**
   * Updates the --hextra-banner-height CSS variable that Hextra's sidebar CSS
   * uses to calculate its fixed top position:
   *   padding-top: calc(var(--navbar-height) + var(--hextra-banner-height))
   * We set it to the banner's actual rendered height when visible, 0px when hidden.
   */
  function setBannerHeight(banner) {
    var height = banner.hasAttribute("hidden") ? "0px" : banner.offsetHeight + "px";
    document.documentElement.style.setProperty("--hextra-banner-height", height);
  }

  // ---------------------------------------------------------------------------
  // GA4 helper — no-ops gracefully when gtag is unavailable
  // ---------------------------------------------------------------------------

  function track(eventName, params) {
    if (typeof window.gtag === "function") {
      window.gtag("event", eventName, params || {});
    }
  }

  // ---------------------------------------------------------------------------
  // Banner initialization
  // ---------------------------------------------------------------------------

  function init() {
    var banner = document.getElementById("sortie-version-banner");
    if (!banner) return;

    var latestVersion = banner.dataset.version;
    if (!latestVersion) return;

    var seenVersion = getCookie(COOKIE_NAME);

    // Suppress the banner when the visitor has already acknowledged this
    // version or a newer one (e.g. rolled back docs, unlikely but safe).
    if (seenVersion && !isNewer(latestVersion, seenVersion)) return;

    // Reveal the banner.  It is rendered with the [hidden] attribute to
    // prevent a flash of content before this script has a chance to decide
    // whether to show it.
    banner.removeAttribute("hidden");
    setBannerHeight(banner);

    track("version_banner_shown", {
      banner_version: latestVersion,
      previous_version: seenVersion || "none",
    });

    // --- Close button --------------------------------------------------------
    var closeBtn = document.getElementById("sortie-banner-close");
    if (closeBtn) {
      closeBtn.addEventListener("click", function () {
        banner.setAttribute("hidden", "");
        setBannerHeight(banner);
        setCookie(COOKIE_NAME, latestVersion);
        track("version_banner_closed", { banner_version: latestVersion });
      });
    }

    // --- "What's new" link ---------------------------------------------------
    // The cookie is written immediately so that even if the visitor navigates
    // to /changelog and then returns, the banner is no longer shown.
    var link = document.getElementById("sortie-banner-link");
    if (link) {
      link.addEventListener("click", function () {
        setCookie(COOKIE_NAME, latestVersion);
        // transport_type:"beacon" uses navigator.sendBeacon() which survives
        // page unload — without it the hit is dropped when the browser
        // navigates away before the async XHR completes.
        track("version_banner_clicked", {
          banner_version: latestVersion,
          page_location: window.location.pathname,
          transport_type: "beacon",
        });
        // Navigation proceeds normally via the href — no preventDefault.
      });
    }
  }

  // The script tag is loaded with `defer`, so the DOM is ready by the time
  // this runs.  The readyState guard is a defensive fallback.
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
