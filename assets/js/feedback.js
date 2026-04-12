document.addEventListener("DOMContentLoaded", function () {
  const container = document.querySelector(".page-feedback");
  if (!container) return;

  const buttons = container.querySelectorAll(".feedback-btn");
  const actions = container.querySelector(".page-feedback__actions");
  const thanks = container.querySelector(".page-feedback__thanks");

  buttons.forEach(function (btn) {
    btn.addEventListener("click", function () {
      const value = parseInt(this.getAttribute("data-value"), 10);
      const page = document.location.pathname;

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
