#!/bin/sh
# Build da Vercel. Em produção, aplica antes as migrações pendentes no banco
# (DATABASE_URL da Vercel, o Postgres da VPS). Se uma migração falhar, o build
# falha e a versão anterior continua no ar. Previews não mexem no banco.
set -e
if [ "$VERCEL_ENV" = "production" ]; then
  npm run db:migrate
fi
npm run build -w web
