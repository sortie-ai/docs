document.addEventListener("DOMContentLoaded", function () {
  var article =
    document.querySelector("article") ||
    document.querySelector('[role="main"]') ||
    document.querySelector(".md-content");
  if (!article) return;

  var container = document.createElement("div");
  container.className = "page-feedback";
  container.innerHTML =
    '<hr style="margin: 2rem 0 1rem;">' +
    '<p style="margin-bottom: 0.5rem; opacity: 0.7;">Was this page helpful?</p>' +
    '<button class="feedback-btn" data-value="1" title="This page was helpful" aria-label="This page was helpful">👍</button> ' +
    '<button class="feedback-btn" data-value="0" title="This page could be improved" aria-label="This page could be improved">👎</button>' +
    '<p class="feedback-thanks" style="display:none; margin-top: 0.5rem; opacity: 0.7;"></p>';

  article.appendChild(container);

  var buttons = container.querySelectorAll(".feedback-btn");
  var thanks = container.querySelector(".feedback-thanks");

  buttons.forEach(function (btn) {
    btn.style.cssText =
      "cursor:pointer; font-size:1.5rem; background:none; border:1px solid rgba(128,128,128,0.3); border-radius:6px; padding:0.25rem 0.75rem; margin-right:0.25rem; transition: border-color 0.2s;";
    btn.addEventListener("mouseenter", function () {
      this.style.borderColor = "rgba(128,128,128,0.6)";
    });
    btn.addEventListener("mouseleave", function () {
      this.style.borderColor = "rgba(128,128,128,0.3)";
    });
    btn.addEventListener("click", function () {
      var value = parseInt(this.getAttribute("data-value"));
      var page = document.location.pathname;

      // Send to GA4 if available and consent given
      if (typeof gtag === "function") {
        gtag("event", "page_feedback", {
          page: page,
          rating: value,
        });
      }

      buttons.forEach(function (b) {
        b.disabled = true;
        b.style.opacity = "0.4";
      });
      thanks.style.display = "block";
      thanks.textContent =
        value === 1
          ? "Thanks for your feedback!"
          : "Thanks for your feedback! Help us improve — open an issue on GitHub.";
    });
  });
});
