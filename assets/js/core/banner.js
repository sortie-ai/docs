// Override Hextra's core/banner.js.
//
// Hextra's original (active when site.Params.banner is truthy) queries
// .hextra-banner-close-button to wire up close behaviour and localStorage.
// Our version-banner.js handles that entirely — including GA tracking, the
// per-version cookie, and updating --hextra-banner-height.  This file is an
// intentional no-op to prevent a TypeError on the missing close-button query.
