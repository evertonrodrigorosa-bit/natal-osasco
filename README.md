# Natal Osasco · Tarefas

App web (PWA) para organizar as tarefas da decoração de Natal de Osasco por setor.

- Gestor entra com senha (variável `GESTOR_SENHA`), cria setores, tarefas, subtarefas e cadastra a equipe (nome + celular).
- Funcionário entra digitando o celular. Vê tudo, mas só escreve observação e usa Iniciar/Finalizar nas tarefas com o nome dele.
- Subtarefas ficam travadas até a tarefa principal ser finalizada; o app avisa quem foi liberado e oferece aviso por WhatsApp.

Rodar: `DATABASE_URL=... GESTOR_SENHA=... npm start`
