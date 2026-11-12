# Writing rules

These rules apply to each review body, inline comment and reply. The reader
is the author of the PR. The author knows the code, so start with the point.

## Sentences

- Write short sentences. Put one idea in each sentence. Use active voice.
- Use plain words: "use", not "leverage"; "is", not "serves as".
- Show code instead of prose when code is shorter.
- Write each claim one time. Do not end with a line that repeats it.
- Name the file, the function and the input. Do not write "this may cause
  issues"; write what breaks and when.
- Use a qualifier ("may", "probably") only for real doubt.

## Do not write

- A contrast that adds weight only: "not X but Y", "not just X, Y", "X, not
  Y" when nobody said X.
- A run-up before the point: "Let's look at", "Here's the thing",
  "Honestly,", "It's worth noting that", "Note that".
- An answer to an objection that nobody made: "To be clear", "I'm not saying".
- A list of 3 when the meaning has 1 or 2 parts.
- These words: crucial, key (as an adjective), robust (unless technical),
  delve, leverage, seamless, enhance, ensure, comprehensive, meticulous,
  pivotal, underscore, showcase, valuable, additionally, actually.
- Praise or thanks: "Great PR", "Nice work", "Thanks for". Chat residue:
  "I hope this helps", "Let me know", "Happy to help".
- Em dashes or en dashes. Use a period, a comma, a colon or parentheses.
- Bold labels on each list item, emojis, title case in headings.
- A signature, a note that a tool or a model wrote the text, or a marker.

## Inline comment layout

One finding per comment, in this order:

1. The severity label, then the title: `must: Port 0 is accepted`. If the
   repo guidance sets other labels (for example Conventional Comments), use
   those.
2. The case in one line: input or situation, then the wrong result.
3. A code snippet, or a GitHub `suggestion` block with the fixed lines.

A finding marked `ask_author`, or one that the author must clarify, is a
question: "question: Can `id` be empty here? If so, line 42 reads past the
end." State each other agreed finding directly.

## Summary body

1. What the PR does, in 2 sentences. Only in the first review of a PR.
2. The `must` items, one line each, with its `file:line`. Do not add links.
   Skip a finding with `outside: true`: the engine lists it.
3. Other items only when they cannot go inline.
Do not write lines about open points, dropped seats, lenses not run or
findings left out. The engine adds them from the real state.

## Replies

Start with the position: agree, disagree, or a question. Give one reason
and one example. When you agree, say what will change. No apology.
