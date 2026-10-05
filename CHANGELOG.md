# Changelog

## 0.1.0 (2026-10-05)


### Features

* **harness:** расширение Pi pi-alert — ошибка/лимит после ретраев в alert-файл; хук обёртки добавляет его к pi -p (TASK-271) ([1c39f36](https://github.com/apolenkov/agent-runner-guard/commit/1c39f36528037a51862a1014939b8ce940e3b06c))
* **hooks:** хук PreToolUse оборачивает devin -p и pi -p в сторож ([01b2ec3](https://github.com/apolenkov/agent-runner-guard/commit/01b2ec3b38b6ef7e5b21d34574377e723611fb27))
* mask — единая функция маскирования секретов ([eb595c6](https://github.com/apolenkov/agent-runner-guard/commit/eb595c6e9cfa6457cfe93c16f2c7b4489fedf446))
* proc — помощники процессов (ps/lsof/потомки/проверки) ([0dc3d54](https://github.com/apolenkov/agent-runner-guard/commit/0dc3d54e66f9357d71233fae83f8ea936922f2e8))
* **proc:** столбец pgid в ProcessInfo ([1bc1591](https://github.com/apolenkov/agent-runner-guard/commit/1bc1591c22ddefa5e575b39269adb184d7c9cdce))
* **proc:** столбец stat в ps (зомби) и экспорт executorOf ([6ada1ca](https://github.com/apolenkov/agent-runner-guard/commit/6ada1cad88ddb34e6fd9a95da1195e3f1e977732))
* tail — чтение только хвоста файла ([4b96a42](https://github.com/apolenkov/agent-runner-guard/commit/4b96a42cc024bc66e34ab6296551d9ca37665587))
* **watchdog:** живые события — лимит и отказ инструмента по выводу, alert-файл хуков, вердикты WAITING/FAILED (TASK-271) ([eddf8bc](https://github.com/apolenkov/agent-runner-guard/commit/eddf8bc2ef56dbef69ea37c9afab832c37cf8ec1))
* **watchdog:** исполнитель codex и замок BUSY от повторного запуска (TASK-210) ([4b1b30d](https://github.com/apolenkov/agent-runner-guard/commit/4b1b30d8058f388b4216a3f7c19265f7d2a67fc1))
* **watchdog:** сторож запусков devin и pi (тишина, потолок, лимит, группа процессов) ([e4502d6](https://github.com/apolenkov/agent-runner-guard/commit/e4502d681f0023239b1e670ed3edb6d6344ae697))
* имя карточки — задача запуска, id мелко ([112d053](https://github.com/apolenkov/agent-runner-guard/commit/112d053350f6af36e49481af63f1bb8d80442615))


### Bug Fixes

* **hooks:** --max-seconds по таймауту переднего плана; без permissionDecision ([c324979](https://github.com/apolenkov/agent-runner-guard/commit/c324979a8ed7dcefa4aa49a9abb67f08a629d7a8))
* **hooks:** передний план без timeout — потолок по умолчанию 105 с (120 с Bash минус запас) ([04640f6](https://github.com/apolenkov/agent-runner-guard/commit/04640f6bf5b4ae2f6aa736a975061107f9ef03b7))
* **hooks:** путь к сторожу в команде хука экранируется одинарными кавычками ([68d547e](https://github.com/apolenkov/agent-runner-guard/commit/68d547e759912fb06cbc48805967f7d8f61413cb))
* **hooks:** шестое ревью Codex — любой &lt;&lt; в команде оставляет pi -p без расширения (тело heredoc не портится) (TASK-271) ([2aee28c](https://github.com/apolenkov/agent-runner-guard/commit/2aee28c8bce8814ea2d36f5743685f30c9c2fe3d))
* mask — имена секретов в любом регистре и Authorization: Basic ([6a09315](https://github.com/apolenkov/agent-runner-guard/commit/6a09315c79d844b751dbdbdeb3f3a0b7472400f8))
* **mask:** пробелы вокруг =, Authorization: token, префиксы ghp_/xoxb-/AKIA ([78effb0](https://github.com/apolenkov/agent-runner-guard/commit/78effb06ac588db74574eb67e4f834ef26c45548))
* **watchdog:** recognise the Codex spend cap as a rate limit ([#1](https://github.com/apolenkov/agent-runner-guard/issues/1)) ([e1a1647](https://github.com/apolenkov/agent-runner-guard/commit/e1a16476dd3b933e0451e2e2adafb449bd96ca4b))
* **watchdog:** замок BUSY — слушатели до записи замка, безопасное снятие просроченного, ключ с каталогом и содержимым кавычек; тесты убивают только свои pid (ревью Codex) ([5af03de](https://github.com/apolenkov/agent-runner-guard/commit/5af03dea14286ff98e42ae72cbf16ddca59a5ffc))
* **watchdog:** замок BUSY ловит повторы по prompt-файлу, атомарно и по живой группе; лимит codex точнее (TASK-210) ([5325e7f](https://github.com/apolenkov/agent-runner-guard/commit/5325e7f64695e58bdc5ab6e75fb773a5b62741f8))
* **watchdog:** замок после RATE_LIMIT/STALLED снимается, когда только что вышедшая группа исчезает (до 1 с) — без лишних файлов замков под нагрузкой (TASK-210) ([e21e84f](https://github.com/apolenkov/agent-runner-guard/commit/e21e84fe3bd916482ed486db03ac1946ce17df74))
* **watchdog:** лимит и код выхода видны, когда раннер отправляет вывод исполнителя в файл (TASK-208) ([fa60e14](https://github.com/apolenkov/agent-runner-guard/commit/fa60e14888bed237f92f24255fee948d485d70d5))
* **watchdog:** надзор за всей группой процессов, EPIPE, SIGKILL только живой группе ([54a77ef](https://github.com/apolenkov/agent-runner-guard/commit/54a77ef192cbb3bcf7d7c5b855937cbc9f2e1031))
* **watchdog:** повторное ревью Codex — перезапись файла отличается от дописывания по байтам перед отметкой, alert-файл читается целиком (до 1 МБ), -e к pi -p за приставками и с путём; Pi обрезает текст ошибки до 2000 символов (TASK-271) ([43c552c](https://github.com/apolenkov/agent-runner-guard/commit/43c552ce7f0e07b803e3f27c3154a430b28cd333))
* **watchdog:** потолок и в фоне, без остановки по исчезновению родителя, ограниченное ожидание после остановки ([67a6e3f](https://github.com/apolenkov/agent-runner-guard/commit/67a6e3fea6fe2f24a74722ea9f25c59069447dcf))
* **watchdog:** признак лимита Devin без quota; исполнитель после env/timeout/nohup ([5be684a](https://github.com/apolenkov/agent-runner-guard/commit/5be684acc9bfbc0a5ad940ecf7a02ccfe2126a97))
* **watchdog:** пятое ревью Codex — перезапись файла по усадке ниже отметки вместо разбора редиректов (старый отказ до перезаписи не событие), heredoc только вне кавычек (TASK-271) ([5d3aa00](https://github.com/apolenkov/agent-runner-guard/commit/5d3aa004f7797e20037d4401005e3d70166e609f))
* **watchdog:** ревью Codex — только новый вывод запуска, отдельные хвосты stdout/stderr, событие не теряется при чтении файлов, маска и абсолютный alert-файл; -e только к pi -p в позиции команды вне кавычек (TASK-271) ([1a791a4](https://github.com/apolenkov/agent-runner-guard/commit/1a791a4fc87f7d45b9424bb75af0ede2db736468))
* **watchdog:** третье ревью Codex — FIFO в --watch-file не блокирует запуск, Pi отдаёт ошибку целиком (тип и маска по полному тексту), кавычки проверяются у самого токена pi (TASK-271) ([51e3948](https://github.com/apolenkov/agent-runner-guard/commit/51e39485773d6c6fdbb2276e4006c7c71fc9f7d2))
* **watchdog:** четвёртое ревью Codex — первый редирект &gt; читается с начала (повтор с тем же отказом не теряется), время сброса берётся из полного текста события, heredoc не получает -e (TASK-271) ([451dd63](https://github.com/apolenkov/agent-runner-guard/commit/451dd6329b4c5bc6932f5f92bb5b4bac4bd2e596))
* автоочистка не забывает снятую с архива метку «остановлен»; относительный файл вывода раннера разрешается от cd/cwd; хвост лога без чтения целиком (ревью Codex) ([1ee397a](https://github.com/apolenkov/agent-runner-guard/commit/1ee397a712c7725226d9906f4eda4ef8af2b2bf0))
