# 👨‍💼 The hello workflow is how we check the whole pipeline works: a row lands in the
# outbox, the relay starts a workflow, and a worker runs this function.


def format_greeting(name: str) -> str:
    # 🐨 Return "hello " followed by the name.
    # 💰 An f-string does it: f"hello {name}"
    # 🦉 This runs inside a Temporal activity, not the workflow itself, so it may do
    #    anything ordinary Python does. Workflow code must stay deterministic.
    # 🚨 The tests call this with a few names and check the exact string.
    raise NotImplementedError("format_greeting")
