document.addEventListener("DOMContentLoaded", async function () {
  if (typeof mermaid === "undefined") return;

  function isDark() {
    return document.documentElement.classList.contains("dark");
  }

  // Collect diagram sources and unwrap <code> wrappers from fence_code_format
  var pres = document.querySelectorAll("pre.mermaid");
  if (!pres.length) return;

  var sources = [];
  pres.forEach(function (pre, i) {
    var code = pre.querySelector("code");
    sources[i] = code ? code.textContent : pre.textContent;
    pre.textContent = sources[i];
  });

  var rendering = false;

  async function renderAll() {
    if (rendering) return;
    rendering = true;
    try {
      pres.forEach(function (pre, i) {
        pre.textContent = sources[i];
        pre.removeAttribute("data-processed");
      });
      mermaid.initialize({
        startOnLoad: false,
        theme: isDark() ? "dark" : "default",
        linkStyle: "transparent",
        themeVariables: {
          edgeLabelBackground: "transparent",
        },
      });
      await mermaid.run({ nodes: Array.from(pres) });
    } finally {
      rendering = false;
    }
  }

  await renderAll();

  // Re-render when dark/light mode changes
  new MutationObserver(function () {
    renderAll();
  }).observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["class"],
  });
});
