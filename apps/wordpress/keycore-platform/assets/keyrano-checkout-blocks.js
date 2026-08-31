(function () {
  const registry = window.wc?.wcBlocksRegistry;
  const settings = window.wc?.wcSettings;
  const element = window.wp?.element;
  const htmlEntities = window.wp?.htmlEntities;
  if (!registry || !settings || !element || !htmlEntities) return;

  for (const name of [
    "keyrano_synthetic_success",
    "keyrano_synthetic_failure",
    "keyrano_synthetic_cancel",
  ]) {
    const data = settings.getSetting(`${name}_data`, {});
    const label = htmlEntities.decodeEntities(data.title || name);
    const content = element.createElement(
      "p",
      null,
      htmlEntities.decodeEntities(data.description || ""),
    );
    registry.registerPaymentMethod({
      ariaLabel: label,
      canMakePayment: () => true,
      content,
      edit: content,
      label,
      name,
      supports: { features: data.supports || ["products"] },
    });
  }
})();
