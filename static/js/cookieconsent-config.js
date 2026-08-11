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
            'Sortie AI, LLC uses Google Analytics to see how the documentation is used — but only if you accept. <strong>Your choice here covers both sortie-ai.com and docs.sortie-ai.com.</strong> The data is pseudonymous rather than anonymous, and is sent to Google in the United States. You can change or withdraw your choice at any time, and declining changes nothing about how the documentation works. See our <a href="https://sortie-ai.com/privacy/" target="_blank" rel="noopener">privacy policy</a> and <a href="https://sortie-ai.com/cookies/" target="_blank" rel="noopener">cookie policy</a>.',
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
                "Analytics cookies help us understand how visitors interact with our documentation. The data is pseudonymous, not anonymous: it is tied to a random identifier stored in your browser, and Google receives your IP address. Declining stops the cookie and the measurement, but your browser still contacts Google to load the analytics script.",
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
                'Full detail is in our <a href="https://sortie-ai.com/cookies/" target="_blank" rel="noopener">cookie policy</a> and <a href="https://sortie-ai.com/privacy/" target="_blank" rel="noopener">privacy policy</a>. Privacy requests go to <a href="mailto:privacy@sortie-ai.com">privacy@sortie-ai.com</a>. Google explains what it does with data from sites that use its services in <a href="https://www.google.com/policies/privacy/partners/" target="_blank" rel="noopener">How Google uses information from sites or apps that use our services</a>.',
            },
          ],
        },
      },
    },
  },
}).then(revealPreferencesControls);

function revealPreferencesControls() {
  document
    .querySelectorAll('[data-cc="show-preferencesModal"][aria-haspopup="dialog"]')
    .forEach((el) => {
      el.hidden = false;
    });
}

function updateGtagConsent() {
  gtag("consent", "update", {
    analytics_storage: CookieConsent.acceptedCategory("analytics")
      ? "granted"
      : "denied",
  });
}
