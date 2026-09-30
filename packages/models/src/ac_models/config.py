"""Every model id the app uses. Change them here and nowhere else."""

# Cheapest current tier ($0.10 in / $0.50 out per 1M tokens). Its reasoning default is
# "medium", but callers always pass effort explicitly: the GPT-5.6 series defaults to "none".
CHAT_MODEL = "gpt-6-luna"
EMBEDDING_MODEL = "text-embedding-3-small"
