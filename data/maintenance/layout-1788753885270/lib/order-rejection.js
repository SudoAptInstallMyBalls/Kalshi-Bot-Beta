// Only explicit, narrowly recognized rejections prove no order was accepted.
// Network errors, generic 404s, conflicts and server failures remain uncertain.
function isDefiniteRejection(error) {
  return error.orderNotSubmitted === true ||
    (error.response?.status === 404 && error.response?.data?.error?.code === 'user_not_found');
}
function notSubmitted(message, reason) {
  return Object.assign(new Error(message), { orderNotSubmitted: true, haltReason: reason });
}
module.exports = { isDefiniteRejection, notSubmitted };
