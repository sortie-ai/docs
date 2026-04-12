document.addEventListener("DOMContentLoaded", function () {
  var container = document.querySelector(".page-feedback");
  if (!container) return;

  var buttons = container.querySelectorAll(".feedback-btn");
  var actions = container.querySelector(".page-feedback__actions");
  var thanks = container.querySelector(".page-feedback__thanks");

  buttons.forEach(function (btn) {
    btn.addEventListener("click", function () {
      var value = parseInt(this.getAttribute("data-value"), 10);
      var page = document.location.pathname;

      if (typeof gtag === "function") {
        gtag("event", "page_feedback", {
          page: page,
          rating: value,
        });
      }

      actions.hidden = true;
      thanks.removeAttribute("hidden");
      thanks.textContent =
        value === 1
          ? "Thanks for your feedback!"
          : "Thanks for your feedback! Help us improve — open an issue on GitHub.";
    });
  });
});
