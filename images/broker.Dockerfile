# Broker container — holds secrets, runs recipes.
#
# Kept deliberately minimal: only node, no shell tooling for the agent to
# pivot into. In production, swap to a distroless image:
#   FROM gcr.io/distroless/nodejs22-debian12
# (You lose the addgroup/adduser convenience — distroless ships with a
#  nonroot user at uid 65532 already.)

FROM node:24-alpine

RUN addgroup -S broker \
  && adduser -S broker -G broker \
  && mkdir -p /run/secrets /broker /workspace \
  && chown -R broker:broker /broker /workspace

WORKDIR /broker

COPY broker/broker-server.mjs /broker/broker-server.mjs

ENV TEST_BROKER_HOST=0.0.0.0
ENV TEST_BROKER_PORT=8765

USER broker

CMD ["node", "/broker/broker-server.mjs"]
