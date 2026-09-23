# Procedure: operations

What an orchestrator asks of a running process, and what it must be told.

## Live and ready

`/live` and `/health` answer 200 while the process serves: a restart is the
only cure for a no.

`/ready` says whether to send this instance traffic. It gates only on what
is local to the instance: its database, its migrations. A dependency every
instance shares (object store, search, a model provider) is reported as a
component, `ok` or `down`, and never flips `ready`, or one blip takes the
whole fleet out of rotation.

```ts
http: {
    readiness: async () => ({
        ready: await Probes.database(),
        components: { search: await Probes.search() },
    }),
},
```

`/ready` is public: cache the report for a few seconds with one probe in
flight, so it cannot be used to hammer what it checks. Name coarse states
only; the cause goes to the log.

## Around it

`http.clientLogs: {}` opens `POST /client-logs` for a browser's own
failures: bounded, counted per address, written to the log only.
`http.hsts: { maxAge }` sends HSTS; it cannot be taken back until it ends.

## Refuses

- `ready: false` for a shared dependency.
- A readiness answer carrying an error message, a host or a credential.
