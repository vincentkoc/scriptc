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
const owned = new Error("owned");
decorate(owned);
console.log(owned[symbol], owned.hidden, owned.receiver === owned, owned.stack.saved);
console.log(Object.getOwnPropertyDescriptor(owned, "hidden").enumerable);
console.log(delete owned.hidden, "hidden" in owned);
Object.freeze(owned);
console.log(Object.isFrozen(owned));
