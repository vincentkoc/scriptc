function format(value) {
  const error = new Error(value);
  error.span = "context";
  error.stack = "custom stack";
  for (const key of ["span", "stack", "other"]) console.log(key, key in error);
  console.log(error.span, error.stack);
  const key = "extra";
  error[key] = 42;
  console.log(error[key]);
}
format("bad");

// Property descriptors and symbols stay on the Error when temporary views leave scope.
const symbol = Symbol("error property");
function decorate(error) {
  error[symbol] = 17;
  Object.defineProperty(error, "hidden", { value: 23, configurable: true });
  Object.defineProperty(error, "receiver", { get() { return this; } });
  error.stack = { saved: true };
  return error;
}
/** @param {any} error */
function checkProperties(error) {
  console.log(error[symbol], error.hidden, error.receiver === error, error.stack.saved);
  console.log(Object.getOwnPropertyDescriptor(error, "hidden").enumerable);
  console.log(delete error.hidden, "hidden" in error);
  Object.freeze(error);
  console.log(Object.isFrozen(error));
}
const owned = new Error("owned");
decorate(owned);
checkProperties(owned);
