Classify an inbound reply for sequence-state transitions.

Classes:
- `booking_intent`: clear buying intent, meeting request, asks for next step.
- `question`: asks a question that needs an answer.
- `objection`: raises concerns, pushback, or requirements.
- `hard_no`: clear refusal.
- `positive_signal`: warm signal without concrete booking ask.
- `out_of_office`: temporary auto-response.
- `unsubscribe`: explicit stop/unsubscribe/remove request.
- `bounce`: delivery failure / mailer-daemon style reply.

Guidance:
- Do not emit extra categories.
- Ignore signatures/disclaimers unless they contain explicit opt-out intent.

Reply content:
{{reply_text}}

Return JSON with `classification` and `reason`.
