---
impacto: capacidade_nova
secao: adicionado
titulo: As imagens do app, do worker e do scheduler podem sair do registro deste fork
---

Um push na branch principal (ou o botão de disparar o workflow) constrói as
três imagens que a VPS sobe — app, worker e scheduler — para linux/amd64 e
publica no registro do GitHub deste fork. A tag do commit não muda; `latest`
aponta para o topo da principal. Quem já instalou a partir do registro de
cima não muda de imagem sozinho: a troca é reescrever `APP_IMAGE`,
`WORKER_IMAGE` e `SCHEDULER_IMAGE` no `.env` e puxar de novo, sem editar o
compose. Confirme `uname -m` igual a `x86_64` antes; estas imagens não têm
versão ARM.
