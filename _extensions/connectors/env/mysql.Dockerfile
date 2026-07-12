# mysql capability: the mysql client so the agent can query the connected database.
RUN apt-get update && apt-get install -y --no-install-recommends default-mysql-client \
    && rm -rf /var/lib/apt/lists/*
