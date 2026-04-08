// Override Hextra's head/banner.js.
//
// Hextra's original reads localStorage['banner-closed'] and, if set, adds the
// 'hextra-banner-hidden' class to <html> + sets --hextra-banner-height to 0px.
// That mechanism conflicts with our per-version cookie logic: a user who closed
// an old banner would never see the banner for a new release.
//
// We own banner visibility entirely via version-banner.js (deferred, body).
// The banner starts with [hidden], so its rendered height is 0.  Set the CSS
// variable accordingly so the sidebar calculates its top-offset correctly
// before version-banner.js has a chance to reveal the banner.
document.documentElement.style.setProperty("--hextra-banner-height", "0px");
