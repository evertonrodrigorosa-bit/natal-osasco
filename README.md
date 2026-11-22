# Natal Osasco · Tarefas

App web (PWA) para repassar e acompanhar as tarefas da decoração de Natal de Osasco por colaborador.

- Gestor entra com senha (variável `GESTOR_SENHA`) e cria tarefas em 4 passos: escolhe um ou vários colaboradores, data e hora da entrega, prioridade (alta, normal, baixa) e título, com anexos (foto, PDF, Word, Excel).
- Colaborador entra digitando o celular e cai direto na própria lista, filtrada primeiro por prioridade.
- Ao abrir a tarefa, o colaborador fica marcado como ciente (o gestor e os colegas da tarefa veem). Cada pessoa aperta Iniciar e Terminar; o app lembra disso o tempo todo.
- Tarefas antigas (um responsável, setores, subtarefas) são migradas sozinhas para o novo formato na primeira subida.

Rodar: `DATABASE_URL=... GESTOR_SENHA=... npm start`
