CookieConsent.run({
  guiOptions: {
    consentModal: {
      layout: "cloud inline",
      position: "bottom center",
      equalWeightButtons: true,
      flipButtons: false,
    },
    preferencesModal: {
      layout: "box",
      equalWeightButtons: true,
      flipButtons: false,
    },
  },

  onFirstConsent: () => {
    updateGtagConsent();
  },
  onConsent: () => {
    updateGtagConsent();
  },
  onChange: () => {
    updateGtagConsent();
  },

  categories: {
    necessary: {
      enabled: true,
      readOnly: true,
    },
    analytics: {
      // The `domain` field is load-bearing. Without it this block did nothing.
      //
      // GA4 writes _ga and _ga_58VR448EJK on the registrable domain
      // .sortie-ai.com, because gtag's cookie_domain defaults to "auto".
      // This library erases against cookie.domain, and run() hard-sets that to
      // location.hostname — "docs.sortie-ai.com". The two strings differ, so
      // the erase missed silently. Measured on the live site before the fix:
      // after "Accept all" → reload → "Reject all", both _ga and
      // _ga_58VR448EJK were still present with 182-day expiries. With the
      // domain added, both are gone in the same state.
      //
      // Use the per-cookie `domain` here, NOT the top-level cookie.domain
      // option — cookie.domain is also the domain cc_cookie itself is written
      // on. Setting it to .sortie-ai.com was measured and it corrupts consent
      // for returning visitors: their existing .docs.sortie-ai.com cc_cookie
      // stays readable, the library writes a *second* record on
      // .sortie-ai.com, and document.cookie then carries two cc_cookie
      // entries. RFC 6265 §5.4 lists the older one first and the library's
      // read regex takes the first match, so a returning visitor's withdrawal
      // of consent silently reverted on the next page load and GA4 resumed
      // writing. The banner never reappeared — the failure is invisible.
      // This form leaves cc_cookie exactly where it is, so no existing
      // visitor is touched at all.
      //
      // /^_ga/ covers _ga and _ga_58VR448EJK both. The former { name: "_gid" }
      // entry is dropped: _gid is a Universal Analytics cookie, GA4 does not
      // set it, and it was never observed in any measured state.
      //
      // One asymmetry to know about: when `domain` is given the library erases
      // only that domain and skips the host-only variant. That is correct
      // while analytics.js leaves cookie_domain at "auto". If it is ever
      // pinned to "none", add a second entry with no domain field.
      autoClear: {
        cookies: [{ name: /^_ga/, domain: ".sortie-ai.com" }],
      },
    },
  },

  language: {
    default: "en",
    translations: {
      en: {
        consentModal: {
          title: "Cookie consent",
          description:
            "We use cookies to recognize your repeated visits and preferences, as well as to measure the effectiveness of our documentation and whether users find what they're searching for. With your consent, you're helping us make our documentation better.",
          acceptAllBtn: "Accept all",
          acceptNecessaryBtn: "Reject all",
          showPreferencesBtn: "Manage preferences",
        },
        preferencesModal: {
          title: "Manage cookie preferences",
          acceptAllBtn: "Accept all",
          acceptNecessaryBtn: "Reject all",
          savePreferencesBtn: "Accept current selection",
          closeIconLabel: "Close modal",
          sections: [
            {
              title: "Cookie usage",
              description:
                "We use cookies to ensure basic functionality and to improve your experience on our documentation site.",
            },
            {
              title: "Strictly necessary cookies",
              description:
                "These cookies are essential for the proper functioning of the website. They cannot be disabled.",
              linkedCategory: "necessary",
              cookieTable: {
                headers: {
                  name: "Name",
                  domain: "Service",
                  description: "Description",
                  expiration: "Expiration",
                },
                body: [
                  {
                    name: "sortie_version_seen",
                    domain: "Sortie Docs",
                    description: `Remembers which release version you last saw so the "what's new" banner is not shown again for the same or older versions.`,
                    expiration: "1 year",
                  },
                  {
                    name: "cc_cookie",
                    domain: "Sortie Docs",
                    description: "Stores your cookie consent preferences.",
                    expiration: "6 months",
                  },
                ],
              },
            },
            {
              title: "Analytics",
              description:
                "Analytics cookies help us understand how visitors interact with our documentation. All data is anonymized.",
              linkedCategory: "analytics",
              cookieTable: {
                headers: {
                  name: "Name",
                  domain: "Service",
                  description: "Description",
                  expiration: "Expiration",
                },
                // This table is a disclosure to the visitor, so it lists the
                // cookies GA4 actually sets here — verified by loading the
                // live site and accepting: _ga and _ga_58VR448EJK, both on
                // .sortie-ai.com, both measured at 182 days.
                //
                // It previously listed _gid, which GA4 never sets (it is a
                // Universal Analytics cookie), and omitted _ga_58VR448EJK,
                // which it does. Expiration is 6 months rather than the GA4
                // default of 2 years because analytics.js passes
                // cookie_expires: 182 * 24 * 60 * 60.
                //
                // The measurement-id suffix is not a placeholder: GA4 names
                // this cookie _ga_<container-id>, so it changes if
                // MEASUREMENT_ID in analytics.js ever changes.
                body: [
                  {
                    name: "_ga",
                    domain: "Google Analytics",
                    description: "Used to distinguish users.",
                    expiration: "6 months",
                  },
                  {
                    name: "_ga_58VR448EJK",
                    domain: "Google Analytics",
                    description: "Used to persist session state.",
                    expiration: "6 months",
                  },
                ],
              },
            },
            {
              title: "More information",
              description:
                'For any questions about our cookie policy, please <a href="https://github.com/sortie-ai/sortie/issues/new" target="_blank" rel="noopener">open an issue</a> on GitHub.',
            },
          ],
        },
      },
    },
  },
});

function updateGtagConsent() {
  gtag("consent", "update", {
    analytics_storage: CookieConsent.acceptedCategory("analytics")
      ? "granted"
      : "denied",
  });
}
