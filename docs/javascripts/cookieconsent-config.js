// Default consent: denied until user accepts
window.dataLayer = window.dataLayer || [];
function gtag() {
  dataLayer.push(arguments);
}
gtag("consent", "default", {
  analytics_storage: "denied",
});

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
      autoClear: {
        cookies: [{ name: /^_ga/ }, { name: "_gid" }],
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
                body: [
                  {
                    name: "_ga",
                    domain: "Google Analytics",
                    description: "Used to distinguish users.",
                    expiration: "2 years",
                  },
                  {
                    name: "_gid",
                    domain: "Google Analytics",
                    description: "Used to distinguish users.",
                    expiration: "24 hours",
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
