import { unaccent } from "@electric-sql/pglite/contrib/unaccent";

import { configureTestKernels } from "../startTestKernel";

// the kit's own Postgres run names an extension as a project would, to prove a migration using it runs in every schema
await configureTestKernels({ pglite: { extensions: { unaccent } } });
