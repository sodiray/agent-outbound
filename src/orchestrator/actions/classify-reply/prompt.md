Classify an inbound reply for sequence-state transitions.

Classes:
- `positive`: clear buying intent, meeting request, asks for next step.
- `negative`: declines interest but not necessarily legal opt-out language.
- `ooo`: out-of-office / temporary unavailability.
- `auto`: automated response that is not OOO.
- `bounce`: delivery failure / mailer-daemon style reply.

Guidance:
- Do not emit extra categories.
- Ignore signatures/disclaimers unless they contain explicit opt-out intent.

Reply content:
{{reply_text}}

Return JSON with `classification` and `reason`.
