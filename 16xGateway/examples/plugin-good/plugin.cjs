/* ============================================================================
 * examples/plugin-good/plugin.cjs
 * A well-behaved outsourced-analytics plugin. It requires ONLY the SDK, calls
 * definePlugin exactly once, and assigns it to module.exports. By the time the
 * handler runs, all PII in the payload has ALREADY been tokenized by the
 * gateway — user_email below is a "[TOKEN_MASK_SHA256_…]" token, never raw PII.
 * ==========================================================================*/

const { definePlugin } = require("@16xbrains/plugin-sdk");

module.exports = definePlugin({
  id: "outsourced-analytics",
  version: "1.0.0",
  description: "Segments and scores a customer record from harmless fields only.",
  handler: function (payload, ctx) {
    ctx.log("info", "scoring record");

    // payload.user_email is a token like "[TOKEN_MASK_SHA256_8cc63f2a91b4]".
    // We can still group/join on it (tokens are deterministic) without ever
    // seeing the real address.
    var lifetimeValue = Number(payload.lifetime_value) || 0;
    var orders = Number(payload.orders) || 0;

    var segment = lifetimeValue > 1000 ? "vip" : orders > 3 ? "loyal" : "standard";
    var score = Math.min(100, Math.round(lifetimeValue / 20 + orders * 5));

    // Echo the payload (still tokenized) plus the derived, non-sensitive fields.
    return Object.assign({}, payload, {
      segment: segment,
      score: score,
      result: "Processed successfully inside isolated sandbox context.",
    });
  },
});
