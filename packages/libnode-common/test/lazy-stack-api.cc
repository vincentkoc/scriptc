#include <node.h>
#include <v8.h>

namespace lazy_stack_test {
using namespace v8;

static Local<String> Text(Isolate* isolate, const char* text) {
  return String::NewFromUtf8(isolate, text).ToLocalChecked();
}

static bool Require(Isolate* isolate, bool condition, const char* message) {
  if (condition) return true;
  isolate->ThrowException(Exception::Error(Text(isolate, message)));
  return false;
}

static void Install(const FunctionCallbackInfo<Value>& args) {
  Isolate* isolate = args.GetIsolate();
  if (!Require(isolate, args.Length() == 3 && args[0]->IsObject() &&
                            args[1]->IsFunction(), "install arguments")) return;
  Maybe<bool> result = Exception::SetLazyStackTrace(
      isolate->GetCurrentContext(), args[0].As<Object>(), args[1].As<Function>(),
      args[2]);
  if (!result.IsNothing()) args.GetReturnValue().Set(result.FromJust());
}

static Local<Array> Frames(Isolate* isolate, Local<StackTrace> trace) {
  Local<Context> context = isolate->GetCurrentContext();
  int count = trace.IsEmpty() ? 0 : trace->GetFrameCount();
  Local<Array> result = Array::New(isolate, count);
  for (int i = 0; i < count; ++i) {
    Local<StackFrame> frame = trace->GetFrame(isolate, i);
    Local<Value> fields[] = {frame->GetFunctionName(),
                            Integer::New(isolate, frame->GetLineNumber()),
                            Integer::New(isolate, frame->GetColumn())};
    result->Set(context, i, Array::New(isolate, fields, 3)).Check();
  }
  return result;
}

static void Trace(const FunctionCallbackInfo<Value>& args) {
  args.GetReturnValue().Set(Frames(args.GetIsolate(),
                                  Exception::GetStackTrace(args[0])));
}

static void Message(const FunctionCallbackInfo<Value>& args) {
  Isolate* isolate = args.GetIsolate();
  Local<v8::Message> message = Exception::CreateMessage(isolate, args[0]);
  args.GetReturnValue().Set(Frames(isolate, message->GetStackTrace()));
}

static void CaptureDetailed(const FunctionCallbackInfo<Value>& args) {
  args.GetIsolate()->SetCaptureStackTraceForUncaughtExceptions(
      args[0]->IsTrue(), 10, StackTrace::kDetailed);
}

static void InstallTrace(const FunctionCallbackInfo<Value>& args) {
  Isolate* isolate = args.GetIsolate();
  Local<StackTrace> before = Exception::GetStackTrace(args[0]);
  Maybe<bool> result = Exception::SetLazyStackTrace(
      isolate->GetCurrentContext(), args[0].As<Object>(), args[1].As<Function>(), args[2]);
  if (result.IsNothing()) return;
  Local<StackTrace> after = Exception::GetStackTrace(args[0]);
  args.GetReturnValue().Set(result.FromJust() && !before.IsEmpty() && before == after);
}

static void Collect(Isolate* isolate) {
  isolate->RequestGarbageCollectionForTesting(Isolate::kFullGarbageCollection);
}

static void PrimitiveFormatter(const FunctionCallbackInfo<Value>& args) {
  Isolate* isolate = args.GetIsolate();
  if (args.Data()->IsExternal()) {
    // The native pointer names a weak handle, not another strong payload root.
    auto* expected = static_cast<Global<Object>*>(args.Data().As<External>()->Value());
    if (!Require(isolate, !expected->IsEmpty() &&
                              args[1]->StrictEquals(expected->Get(isolate)),
                 "retained payload identity")) return;
    Collect(isolate);
    if (!Require(isolate, !expected->IsEmpty() &&
                              args[1]->StrictEquals(expected->Get(isolate)),
                 "payload identity after formatting GC")) return;
  }
  args.GetReturnValue().Set(Text(isolate, "formatted"));
}

// Every Local containing the pair expires before collection. Only target is
// strongly rooted; weak Globals use V8's self-resetting no-callback form.
static void Ownership(const FunctionCallbackInfo<Value>& args) {
  Isolate* isolate = args.GetIsolate();
  Local<Context> context = isolate->GetCurrentContext();
  if (!Require(isolate, args[0]->IsInt32(), "ownership action")) return;
  int action = args[0].As<Int32>()->Value();
  if (!Require(isolate, action >= 0 && action <= 4, "ownership action range")) return;
  Global<Object> target;
  Global<Function> formatter;
  Global<Object> data;
  Global<Object> canary;
  {
    HandleScope scope(isolate);
    Local<Object> object = Exception::Error(Text(isolate, "owned")).As<Object>();
    Local<Function> fn = Function::New(
        context, PrimitiveFormatter, External::New(isolate, &data)).ToLocalChecked();
    Local<Object> payload = Object::New(isolate);
    target.Reset(isolate, object);
    formatter.Reset(isolate, fn);
    formatter.SetWeak();
    data.Reset(isolate, payload);
    data.SetWeak();
    canary.Reset(isolate, Object::New(isolate));
    canary.SetWeak();
    if (!Require(isolate, Exception::SetLazyStackTrace(context, object, fn, payload)
                              .FromMaybe(false), "ownership installation")) return;
  }
  for (int i = 0; i < 8 && !canary.IsEmpty(); ++i) Collect(isolate);
  if (!Require(isolate, canary.IsEmpty(), "GC canary retained")) return;
  if (!Require(isolate, !formatter.IsEmpty() && !data.IsEmpty(),
               "lazy pair not retained by owner")) return;
  {
    HandleScope scope(isolate);
    Local<Object> object = target.Get(isolate);
    if (action == 0) {
      Local<Value> value;
      if (!object->Get(context, Text(isolate, "stack")).ToLocal(&value)) return;
      if (!Require(isolate, value->StrictEquals(Text(isolate, "formatted")),
                   "formatted primitive")) return;
    } else if (action == 1) {
      if (!object->Set(context, Text(isolate, "stack"), Integer::New(isolate, 7))
               .FromMaybe(false)) return;
    } else if (action == 2) {
      if (!Exception::CaptureStackTrace(context, object).FromMaybe(false)) return;
    } else if (action == 3) {
      Local<Function> replacement = Function::New(context, PrimitiveFormatter).ToLocalChecked();
      if (!Exception::SetLazyStackTrace(context, object, replacement, Null(isolate))
               .FromMaybe(false)) return;
    }
  }
  if (action == 4) target.Reset();
  int rounds = 0;
  while (rounds < 8 && (!formatter.IsEmpty() || !data.IsEmpty())) {
    Collect(isolate);
    ++rounds;
  }
  if (!Require(isolate, formatter.IsEmpty() && data.IsEmpty(),
               "obsolete formatter/data retained")) return;
  args.GetReturnValue().Set(rounds);
}

static void Terminate(const FunctionCallbackInfo<Value>& args) {
  args.GetIsolate()->TerminateExecution();
}

static void Termination(const FunctionCallbackInfo<Value>& args) {
  Isolate* isolate = args.GetIsolate();
  Local<Context> context = isolate->GetCurrentContext();
  Local<Object> target = Object::New(isolate);
  Local<Object> data = Object::New(isolate);
  data->Set(context, Text(isolate, "calls"), Integer::New(isolate, 0)).Check();
  Local<Function> terminate = Function::New(context, Terminate).ToLocalChecked();
  Local<Function> factory = Script::Compile(context, Text(isolate,
      "(function(terminate) { return function(holder, data, allowed) {"
      " if (++data.calls === 1) { terminate(); for (;;) {} } return data; }; })"))
      .ToLocalChecked()->Run(context).ToLocalChecked().As<Function>();
  Local<Value> argv[] = {terminate};
  Local<Function> formatter = factory->Call(context, Undefined(isolate), 1, argv)
      .ToLocalChecked().As<Function>();
  if (!Exception::SetLazyStackTrace(context, target, formatter, data)
           .FromMaybe(false)) return;
  bool terminated;
  {
    TryCatch caught(isolate);
    Local<Value> value;
    bool empty = !target->Get(context, Text(isolate, "stack")).ToLocal(&value);
    terminated = empty && caught.HasTerminated() && !caught.CanContinue();
    isolate->CancelTerminateExecution();
    caught.Reset();
  }
  if (!Require(isolate, terminated, "termination did not propagate")) return;
  Local<Value> later;
  if (!target->Get(context, Text(isolate, "stack")).ToLocal(&later)) return;
  Local<Value> calls = data->Get(context, Text(isolate, "calls")).ToLocalChecked();
  if (!Require(isolate, calls->Int32Value(context).FromJust() == 2 && later->StrictEquals(data),
               "termination cached a value")) return;
  args.GetReturnValue().Set(true);
}

NODE_MODULE_INIT() {
  NODE_SET_METHOD(exports, "install", Install);
  NODE_SET_METHOD(exports, "trace", Trace);
  NODE_SET_METHOD(exports, "message", Message);
  NODE_SET_METHOD(exports, "captureDetailed", CaptureDetailed);
  NODE_SET_METHOD(exports, "installTrace", InstallTrace);
  NODE_SET_METHOD(exports, "ownership", Ownership);
  NODE_SET_METHOD(exports, "termination", Termination);
}
}  // namespace lazy_stack_test
