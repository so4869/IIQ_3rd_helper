# Scouter APM — Tomcat 설치 가이드

> 오픈소스 APM(Application Performance Monitoring) **Scouter** 를 Tomcat 기반 웹 애플리케이션에 적용하는 절차입니다.
> 프로젝트: <https://github.com/scouter-project/scouter>

---

## 0. 최신 버전 / 다운로드 링크 (2026-06-26 기준)

- **최신 버전: `v2.21.3`** (릴리스 일자: 2026-02-15)
- 릴리스 페이지: <https://github.com/scouter-project/scouter/releases/latest>

| 구분 | 파일 | 다운로드 |
|------|------|----------|
| **통합 패키지** (서버 + Java 에이전트 + Host 에이전트) | `scouter-all-2.21.3.tar.gz` | <https://github.com/scouter-project/scouter/releases/download/v2.21.3/scouter-all-2.21.3.tar.gz> |
| 클라이언트 (Windows) | `scouter.client.product-win32.win32.x86_64.zip` | <https://github.com/scouter-project/scouter/releases/download/v2.21.3/scouter.client.product-win32.win32.x86_64.zip> |
| 클라이언트 (Linux) | `scouter.client.product-linux.gtk.x86_64.tar.gz` | <https://github.com/scouter-project/scouter/releases/download/v2.21.3/scouter.client.product-linux.gtk.x86_64.tar.gz> |
| 클라이언트 (macOS, Apple Silicon) | `scouter.client.product-macosx.cocoa.aarch64.tar.gz` | <https://github.com/scouter-project/scouter/releases/download/v2.21.3/scouter.client.product-macosx.cocoa.aarch64.tar.gz> |
| 클라이언트 (macOS, Intel) | `scouter.client.product-macosx.cocoa.x86_64.tar.gz` | <https://github.com/scouter-project/scouter/releases/download/v2.21.3/scouter.client.product-macosx.cocoa.x86_64.tar.gz> |

> **통합 패키지(`scouter-all`)** 하나만 받으면 서버와 에이전트가 모두 들어 있습니다.
> 압축을 풀면 `scouter/server`, `scouter/agent.java`, **`scouter/agent.java21plus`**, `scouter/agent.host` 디렉터리로 구성됩니다.
>
> ⚠️ **Java 에이전트는 JDK 버전에 따라 폴더가 다릅니다.**
> - **JDK 8 ~ 20**: `scouter/agent.java`
> - **JDK 21 이상**: `scouter/agent.java21plus` *(Java 21+ 전용 빌드 — Virtual Thread 등 최신 런타임 대응)*
>
> 자세한 선택 기준은 [4-1절](#4-1-에이전트-배치--jdk-버전별-폴더-선택)을 참고하세요.

---

## 1. 구성 요소 및 아키텍처

Scouter는 3개의 핵심 구성 요소로 동작합니다.

```
 ┌─────────────────┐        UDP/TCP 6100        ┌──────────────────┐
 │  Tomcat (WAS)   │ ─────────────────────────▶ │  Collector       │
 │  + Java Agent   │   성능 데이터 전송          │  (Scouter Server)│
 └─────────────────┘                            └──────────────────┘
                                                          ▲
 ┌─────────────────┐        UDP/TCP 6100                  │ TCP 6100
 │  Host Agent     │ ──────────────────────────────────▶ │
 │  (OS 자원 수집) │                                       │
 └─────────────────┘                            ┌──────────────────┐
                                                │  Client (Viewer) │
                                                └──────────────────┘
```

| 구성 요소 | 디렉터리 | 역할 |
|-----------|----------|------|
| **Collector / Server** | `scouter/server` | 에이전트가 보내는 데이터를 수집·저장하고 클라이언트에 제공 |
| **Java Agent** | `scouter/agent.java` | Tomcat JVM에 `-javaagent` 로 부착되어 트랜잭션/SQL/응답시간 등을 수집 |
| **Host Agent** | `scouter/agent.host` | CPU/메모리/디스크 등 OS 자원 수집 (선택) |
| **Client** | 별도 다운로드 | 데이터를 시각화하는 데스크톱 뷰어 |

---

## 2. 사전 준비 사항

- **JDK**
  - Scouter Server: **Java 8 이상** 필요 (최신 빌드는 Java 11+ 권장)
  - Java Agent: 모니터링 대상 Tomcat의 JDK 버전에 맞는 빌드 사용 — **JDK 8~20 → `agent.java`, JDK 21+ → `agent.java21plus`** (4-1절 참고)
- **Tomcat**: 모니터링 대상 인스턴스 (버전 무관, 7~11 대응)
- **네트워크/방화벽 포트** (기본값)
  - `6100/TCP`, `6100/UDP` — 에이전트 → 서버, 클라이언트 → 서버
  - `6188/TCP` — 서버 HTTP API (선택)
  - 서버와 Tomcat이 다른 장비라면 해당 포트의 인바운드 허용 필요
- **권장 리소스**: 서버 JVM 힙 최소 1GB 이상 (대상 규모에 따라 증설)

---

## 3. Scouter Server(Collector) 설치

### 3-1. 압축 해제

```bash
# Linux
tar xvzf scouter-all-2.21.3.tar.gz
cd scouter/server
```

```powershell
# Windows (PowerShell) — tar 내장 사용
tar -xvzf scouter-all-2.21.3.tar.gz
cd scouter\server
```

### 3-2. (선택) 설정 (`conf/scouter.conf`)

> ⚠️ **이 단계는 선택 사항입니다.** 설정 파일을 건드리지 않아도 **기본값으로 바로 동작**합니다. 포트 변경·보관 기간·저장 경로 등을 조정하려는 경우에만 아래를 수정하세요. 처음 설치라면 이 절을 건너뛰고 [3-3. 서버 기동](#3-3-서버-기동)으로 진행해도 됩니다.

운영 시 아래 항목을 확인합니다.

```properties
# 수신 포트 (기본 6100)
net_tcp_listen_port=6100
net_udp_listen_port=6100

# HTTP API 포트 (선택)
net_http_server_port=6188
net_http_api_enabled=true

# 데이터 저장 경로
db_dir=./database

# 데이터 보관 일수 (디스크 용량 고려)
mgr_purge_profile_keep_days=10
mgr_purge_xlog_keep_days=30
mgr_purge_counter_keep_days=70

# UDP 패킷 최대 크기 (대용량 환경 시 조정)
net_udp_packet_max_bytes=60000
```

### 3-3. 서버 기동

```bash
# Linux
./startup.sh        # 백그라운드 실행
# 또는 직접 실행
java -Xmx1024m -jar scouter-server-boot.jar
```

```powershell
# Windows
.\startup.bat
```

기동 후 콘솔 로그에 `Scouter Collector Version ...` 및 포트 리슨 메시지가 보이면 정상입니다.

> ⚠️ **기동 시 에러가 난다면 먼저 [7-1. 트러블슈팅](#7-1-트러블슈팅-자주-발생하는-문제)을 확인하세요.**
> - **JDK 11/17/21** 로 서버를 띄우면 `NoSuchMethodException: sun.misc.Unsafe.defineClass` (JAXB) 오류로 죽습니다 → [해결책](#1-서버-기동-시-nosuchmethodexception-sunmiscunsafedefineclass--jaxb-오류)
> - `Can't lock the database` 오류 → [해결책](#2-cant-lock-the-database--please-remove-the-lock--databaselockdat)

---

## 4. Tomcat에 Java Agent 적용 (핵심)

### 4-1. 에이전트 배치 — JDK 버전별 폴더 선택

Tomcat이 구동되는 **JDK 버전에 맞는** 에이전트 폴더를 Tomcat 장비로 복사합니다.

| Tomcat 구동 JDK | 사용할 폴더 | 비고 |
|------------------|------------|------|
| **JDK 8 ~ 20** | `scouter/agent.java` | 기존 표준 에이전트 |
| **JDK 21 이상** | `scouter/agent.java21plus` | Java 21+ 전용 빌드 (`-Pjava-21-plus`). Virtual Thread 등 최신 런타임 대응 |

```bash
# 예) JDK 21 이상인 경우
cp -r scouter/agent.java21plus /opt/scouter/agent.java21plus
```

```powershell
# Windows 예) JDK 21 이상인 경우
Copy-Item -Recurse scouter\agent.java21plus C:\scouter\agent.java21plus
```

핵심 파일(두 폴더 동일):
- `scouter.agent.jar` — 에이전트 본체
- `conf/scouter.conf` — 에이전트 설정

> **주의**
> - `-javaagent:` 경로를 반드시 사용 중인 JDK에 맞는 폴더로 지정하세요. JDK 21에서 구버전 `agent.java` 를 쓰면 클래스 파일 버전/Virtual Thread 관련 문제로 정상 동작하지 않을 수 있습니다.
> - 이하 예시에서 경로는 `agent.java` 로 표기하지만, **JDK 21 이상이면 `agent.java21plus` 로 바꿔** 적용하면 됩니다.
> - 폴더가 달라져도 [4-6절](#4-6-jdk-11-이상jdk-17--21-추가-jvm-옵션)의 `--add-opens`/`--add-exports` 옵션은 **여전히 필요**합니다(런타임 모듈 접근 문제이므로 에이전트 빌드와 무관).

### 4-2. 에이전트 설정 (`agent.java/conf/scouter.conf`)

```properties
# 이 Tomcat 인스턴스를 식별하는 이름 (반드시 인스턴스별로 유니크하게)
obj_name=tomcat-app1

# Collector(서버) 주소
net_collector_ip=127.0.0.1
net_collector_udp_port=6100
net_collector_tcp_port=6100

# (선택) HTTP 파라미터/헤더 수집
profile_http_querystring_enabled=true
profile_http_parameter_enabled=false   # 민감정보 주의

# (선택) SQL 수집
profile_sql_enabled=true
```

> `obj_name` 은 클라이언트 화면에서 인스턴스를 구분하는 이름입니다.
> 한 장비에서 여러 Tomcat을 띄운다면 `tomcat-app1`, `tomcat-app2` 처럼 **반드시 다르게** 지정하세요.

### 4-3. Tomcat JVM 옵션 등록 (`setenv`)

Tomcat은 `bin/setenv.sh`(Linux) / `bin/setenv.bat`(Windows) 파일이 있으면 기동 시 자동으로 읽습니다. 없으면 새로 만듭니다.

> 💡 **JDK 11 이상(JDK 17 / 21 포함)** 을 사용한다면 아래 기본 옵션에 더해 **[4-6절](#4-6-jdk-11-이상jdk-17--21-추가-jvm-옵션)** 의 `--add-opens`/`--add-exports` 옵션을 함께 넣어야 일부 기능이 정상 동작합니다. *적용하는 파일이 바뀌는 것은 아니며(동일하게 `setenv` 또는 `tomcatXw.exe`), 넣을 옵션 줄이 추가되는 것입니다.*

**Linux — `$CATALINA_HOME/bin/setenv.sh`**

```bash
#!/bin/sh
SCOUTER_AGENT_DIR=/opt/scouter/agent.java

CATALINA_OPTS="$CATALINA_OPTS -javaagent:${SCOUTER_AGENT_DIR}/scouter.agent.jar"
CATALINA_OPTS="$CATALINA_OPTS -Dscouter.config=${SCOUTER_AGENT_DIR}/conf/scouter.conf"
CATALINA_OPTS="$CATALINA_OPTS -Dobj_name=tomcat-app1"
export CATALINA_OPTS
```

```bash
chmod +x $CATALINA_HOME/bin/setenv.sh
```

**Windows — `%CATALINA_HOME%\bin\setenv.bat`**

```bat
@echo off
set SCOUTER_AGENT_DIR=C:\scouter\agent.java

set "CATALINA_OPTS=%CATALINA_OPTS% -javaagent:%SCOUTER_AGENT_DIR%\scouter.agent.jar"
set "CATALINA_OPTS=%CATALINA_OPTS% -Dscouter.config=%SCOUTER_AGENT_DIR%\conf\scouter.conf"
set "CATALINA_OPTS=%CATALINA_OPTS% -Dobj_name=tomcat-app1"
```

> **주의**
> - 경로/`obj_name` 에 공백이 있으면 따옴표로 묶으세요.
> - `JAVA_OPTS` 대신 `CATALINA_OPTS` 사용을 권장합니다 (`shutdown` 시 에이전트가 부착되지 않도록).
> - `-Dobj_name` 을 JVM 옵션으로 주면 `scouter.conf` 의 `obj_name` 보다 우선합니다. 한 설정 파일을 여러 인스턴스가 공유할 때 유용합니다.
> - ⚠️ **Windows에서 Tomcat을 "설치형(Windows 서비스)"으로 운영하는 경우 `setenv.bat` 은 무시됩니다.** 이때는 아래 4-4 절차(`tomcatXw.exe`)로 JVM 옵션을 등록해야 합니다.

### 4-4. (Windows 설치형) 서비스로 등록된 Tomcat — `tomcatXw.exe` 설정

Tomcat을 인스톨러로 설치해 **Windows 서비스**로 띄운 경우, 서비스는 `startup.bat`/`setenv.bat` 가 아니라 `procrun`(Commons Daemon)이 기동하므로 JVM 옵션을 서비스 모니터 GUI에서 직접 등록해야 합니다.

> `tomcatXw.exe` 의 `X` 는 메이저 버전 번호입니다. 예: Tomcat 9 → `tomcat9w.exe`, Tomcat 10 → `tomcat10w.exe`, Tomcat 8.5 → `tomcat8w.exe`.

**1) 서비스 모니터(GUI) 실행**

`%CATALINA_HOME%\bin` 에서 `tomcat9w.exe` 를 **관리자 권한**으로 실행합니다.
서비스 이름이 기본값(`Tomcat9`)과 다르면 다음처럼 모니터를 직접 지정합니다.

```bat
:: 형식:  tomcat9w.exe //MS//<서비스명>
cd /d %CATALINA_HOME%\bin
tomcat9w.exe //MS//Tomcat9
```

> 설치된 정확한 서비스명은 `sc query state= all | findstr /i tomcat` 또는 서비스 관리자(`services.msc`)에서 확인할 수 있습니다.

**2) [Java] 탭에서 옵션 추가**

모니터 창 상단의 **`Java`** 탭으로 이동 → **`Java Options`**(또는 `Java 9+` 사용 시 `Java 9 Options`) 입력란 **맨 아래**에 아래 3줄을 **한 줄에 하나씩** 추가합니다.

```
-javaagent:C:\scouter\agent.java\scouter.agent.jar
-Dscouter.config=C:\scouter\agent.java\conf\scouter.conf
-Dobj_name=tomcat-app1
```

> **주의**
> - 각 옵션은 반드시 **별도의 줄**에 입력합니다(공백으로 이어 쓰면 안 됨).
> - 경로에 공백이 있더라도 이 입력란에서는 따옴표로 감싸지 **않습니다**.
> - 필요 시 같은 탭의 **Initial/Maximum memory pool** 로 힙 크기를 조정할 수 있습니다.

**3) 적용 및 재기동**

`Apply` → `OK` 후 같은 모니터의 **`General`** 탭에서 `Stop` → `Start`, 또는:

```bat
net stop Tomcat9
net start Tomcat9
```

**4) 확인**

`%CATALINA_HOME%\logs\` 의 `stdout`/`commons-daemon` 로그 또는 `catalina.*.log` 에서 `[Scouter]` 에이전트 로딩 로그를 확인합니다.

> **참고**: 콘솔(스크립트)로 띄우는 Tomcat과 서비스로 띄우는 Tomcat은 옵션 적용 경로가 서로 다릅니다. 한 장비에서 두 방식을 혼용하지 말고, 운영 방식에 맞는 절차(4-3 또는 4-4) 한쪽만 사용하세요.

### 4-5. Tomcat 재기동 (콘솔/스크립트 방식)

```bash
# Linux
$CATALINA_HOME/bin/shutdown.sh
$CATALINA_HOME/bin/startup.sh
```

```powershell
# Windows
%CATALINA_HOME%\bin\shutdown.bat
%CATALINA_HOME%\bin\startup.bat
```

`catalina.out` (또는 콘솔)에 `[Scouter]` 로 시작하는 에이전트 로딩 로그가 보이면 정상입니다.

### 4-6. JDK 11 이상(JDK 17 / 21) 추가 JVM 옵션

Java 9부터 도입된 **모듈 시스템(JPMS)의 강한 캡슐화** 때문에, Java 11 이상에서는 Scouter 에이전트가 JDK 내부 클래스에 접근하려면 `--add-opens` / `--add-exports` 옵션이 추가로 필요합니다. **JDK 17, JDK 21에서도 동일하게 적용**됩니다.

> 핵심: **적용 파일은 그대로** (`setenv.sh`/`setenv.bat`, 설치형은 `tomcatXw.exe`의 Java Options). 단지 아래 옵션 줄을 **추가**합니다.

| 기능 | 필요한 옵션 |
|------|-------------|
| **스크립트 플러그인 동적 로딩** | `--add-opens=java.base/java.lang=ALL-UNNAMED`<br>`--add-exports=java.base/sun.net=ALL-UNNAMED` |
| **Scouter를 통한 Thread Dump** | `--add-opens=jdk.management/com.sun.management.internal=ALL-UNNAMED` |

> 위 기능을 쓰지 않으면 기본 모니터링은 옵션 없이도 동작할 수 있으나, JDK 17/21 환경에서는 `InaccessibleObjectException` 등을 예방하기 위해 **함께 지정하는 것을 권장**합니다.

**Linux — `setenv.sh` (4-3 예시에 추가)**

```bash
# --- JDK 11+ (17/21 포함) 추가 옵션 ---
CATALINA_OPTS="$CATALINA_OPTS --add-opens=java.base/java.lang=ALL-UNNAMED"
CATALINA_OPTS="$CATALINA_OPTS --add-exports=java.base/sun.net=ALL-UNNAMED"
CATALINA_OPTS="$CATALINA_OPTS --add-opens=jdk.management/com.sun.management.internal=ALL-UNNAMED"
```

**Windows — `setenv.bat` (4-3 예시에 추가)**

```bat
:: --- JDK 11+ (17/21 포함) 추가 옵션 ---
set "CATALINA_OPTS=%CATALINA_OPTS% --add-opens=java.base/java.lang=ALL-UNNAMED"
set "CATALINA_OPTS=%CATALINA_OPTS% --add-exports=java.base/sun.net=ALL-UNNAMED"
set "CATALINA_OPTS=%CATALINA_OPTS% --add-opens=jdk.management/com.sun.management.internal=ALL-UNNAMED"
```

**Windows 설치형(`tomcatXw.exe`) — [Java] 탭 Java Options에 한 줄씩 추가**

```
--add-opens=java.base/java.lang=ALL-UNNAMED
--add-exports=java.base/sun.net=ALL-UNNAMED
--add-opens=jdk.management/com.sun.management.internal=ALL-UNNAMED
```

> **참고**
> - 옵션을 누락하면 해당 기능 사용 시 `module java.base does not "opens java.lang" to unnamed module` 같은 오류가 발생합니다.
> - Host Agent도 JDK 11+ 로 구동한다면 동일 옵션을 `host.bat`/`host.sh` 의 JVM 옵션에 추가할 수 있습니다.

---

## 5. (선택) Host Agent 설치

OS 자원(CPU/메모리/디스크/네트워크)을 함께 보려면 Host Agent를 실행합니다.

```bash
cd scouter/agent.host
# conf/scouter.conf 에 obj_name, net_collector_ip 설정 후
./host.sh        # Linux
.\host.bat       # Windows
```

```properties
# agent.host/conf/scouter.conf
obj_name=host-server1
net_collector_ip=127.0.0.1
net_collector_udp_port=6100
net_collector_tcp_port=6100
```

### 5-1. (Windows) Host Agent를 서비스로 등록

Scouter Host Agent는 **자체 Windows 서비스 설치 기능을 제공하지 않습니다.** (`host.bat` 으로 포그라운드 실행만 제공) 따라서 서비스로 상주시키려면 별도 래퍼 도구를 사용합니다. 아래 방법 중 하나를 선택하세요.

**방법 A — NSSM (권장, 가장 간단)**

[NSSM](https://nssm.cc/) 은 임의의 실행 파일/배치를 서비스로 감싸주는 무료 도구입니다.

```bat
:: 1) nssm 다운로드 후 압축 해제, 관리자 권한 콘솔에서 실행
nssm install ScouterHostAgent

:: GUI가 뜨면 다음과 같이 설정:
::   Application Path : C:\Windows\System32\cmd.exe
::   Arguments       : /c host.bat
::   Startup directory: C:\scouter\agent.host
```

또는 GUI 없이 명령으로:

```bat
nssm install ScouterHostAgent "C:\scouter\agent.host\host.bat"
nssm set ScouterHostAgent AppDirectory "C:\scouter\agent.host"
nssm set ScouterHostAgent Start SERVICE_AUTO_START
nssm start ScouterHostAgent
```

> NSSM은 프로세스가 죽으면 자동 재시작해 주므로 상주형 에이전트에 적합합니다.

**방법 B — WinSW (XML 설정 기반)**

[WinSW](https://github.com/winsw/winsw) 실행 파일을 `scouter-host.exe` 로 복사하고 같은 이름의 XML을 작성합니다.

```xml
<!-- scouter-host.xml -->
<service>
  <id>ScouterHostAgent</id>
  <name>Scouter Host Agent</name>
  <description>Scouter Host Agent (OS resource collector)</description>
  <workingdirectory>C:\scouter\agent.host</workingdirectory>
  <executable>cmd.exe</executable>
  <arguments>/c host.bat</arguments>
  <onfailure action="restart" delay="10 sec"/>
</service>
```

```bat
scouter-host.exe install
scouter-host.exe start
```

**방법 C — `sc.exe` / 작업 스케줄러**

별도 도구 없이 OS 기본 기능만 쓸 경우:
- `schtasks` 로 "시스템 시작 시 / 사용자 로그온과 무관하게(`/RU SYSTEM`)" `host.bat` 실행 작업 등록
- 단, 프로세스 비정상 종료 시 자동 재시작·서비스 상태 관리가 약하므로 운영 환경에서는 방법 A/B를 권장합니다.

```bat
schtasks /create /tn "ScouterHostAgent" /tr "C:\scouter\agent.host\host.bat" /sc onstart /ru SYSTEM /rl HIGHEST
```

> **공통 주의**
> - 어떤 방법이든 서비스 계정(보통 `LocalSystem`)이 `agent.host` 디렉터리와 JDK에 접근 가능해야 합니다.
> - `host.bat` 내부에서 `JAVA_HOME` 을 참조하므로, 서비스 환경에서도 `JAVA_HOME` 이 잡히도록 시스템 환경변수로 설정하거나 `host.bat` 에 명시하세요.

---

## 6. Client(Viewer) 설치 및 접속

1. OS에 맞는 클라이언트를 다운로드해 압축 해제 후 `scouter.exe`(Windows) 또는 실행 파일 기동
2. 접속 정보 입력
   - **Server Address**: `<서버 IP>:6100`
   - **ID / Password**: 기본값 `admin` / `admin` *(최초 로그인 후 즉시 변경 권장)*
3. 좌측 Object 트리에서 `obj_name`(예: `tomcat-app1`) 선택 → XLog/TPS/응답시간 등 확인

---

## 7. 운영 시 고려사항

| 항목 | 내용 |
|------|------|
| **포트/방화벽** | 서버-에이전트-클라이언트가 분리된 경우 `6100/TCP·UDP`, `6188/TCP` 인바운드 허용 |
| **obj_name 유일성** | 인스턴스마다 고유해야 함. 중복 시 데이터가 섞임 |
| **JVM 버전 호환** | 에이전트는 대상 Tomcat의 JDK에서 동작. 매우 오래된 JDK(6/7)는 구버전 에이전트 검토 |
| **디스크 용량** | 서버 `db_dir` 누적 증가. `mgr_purge_*_keep_days` 로 보관 기간 관리 |
| **보안** | 기본 계정(admin/admin) 변경, 수집 포트는 내부망으로 제한. `profile_http_parameter_enabled` 등 민감정보 수집 옵션 주의 |
| **성능 오버헤드** | 일반적으로 미미하나, SQL/파라미터 풀 프로파일링을 과도하게 켜면 부하 증가 |
| **다중 인스턴스** | 동일 장비 여러 Tomcat → `setenv` 의 `-Dobj_name` 으로 인스턴스별 구분 |
| **서버 자동 기동** | 운영 환경에서는 Collector를 systemd 서비스 / Windows 서비스로 등록 권장 |
| **시간 동기화** | 서버·에이전트 장비 간 NTP 시각 동기화 (지표 정확도) |
| **버전 일치** | 서버·에이전트·클라이언트는 동일 버전(`2.21.3`) 사용 권장 |

---

## 7-1. 트러블슈팅 (자주 발생하는 문제)

### (1) 서버 기동 시 `NoSuchMethodException: sun.misc.Unsafe.defineClass` / JAXB 오류

**증상** — `startup.bat`(또는 `startup.sh`) 실행 시 다음과 같은 예외로 서버가 죽음:

```
java.lang.NoSuchMethodException: sun.misc.Unsafe.defineClass(...)
   at com.sun.xml.bind.v2.runtime.reflect.opt.Injector.<clinit>
   ...
Caused by: java.lang.NullPointerException: ... Injector.defineClass is null
   at scouter.server.Configure.<clinit>
```

**원인** — Scouter 서버가 내부적으로 사용하는 **구버전 JAXB(com.sun.xml.bind)** 가 `sun.misc.Unsafe.defineClass` 메서드에 의존하는데, 이 메서드는 **JDK 11에서 제거**되었습니다. 따라서 **JDK 11/17/21** 로 서버를 기동하면 발생합니다.

**해결** — JAXB의 최적화 바이트코드 생성을 비활성화하는 JVM 옵션을 추가합니다(리플렉션 방식으로 우회).

```
-Dcom.sun.xml.bind.v2.bytecode.ClassTailor.noOptimize=true
```

`startup.bat` 예시 (JDK 21):

```bat
@echo off
set "JAVA_HOME=D:\0default\jdk21.0.11_10"
set "SCOUTER_JAVA_OPTS=-Dcom.sun.xml.bind.v2.bytecode.ClassTailor.noOptimize=true"
"%JAVA_HOME%\bin\java" -Xmx1024m %SCOUTER_JAVA_OPTS% -classpath ./scouter-server-boot.jar scouter.boot.Boot ./lib
```

> 정상 기동되면 콘솔에 `The optimized code generation is disabled` (정상 우회 메시지) 후 Jetty가 `0.0.0.0:6180`(HTTP), Collector가 `6100` 포트를 리슨합니다.
> 대안으로 **서버만 JDK 8로 구동**해도 됩니다(서버 JDK는 모니터링 대상 Tomcat의 JDK와 무관). 단, JDK 8이 없으면 위 옵션이 가장 간단합니다.

### (2) `Can't lock the database / Please remove the lock : ...database\lock.dat`

**원인** — 서버가 비정상 종료(강제 kill 등)되어 DB 락 파일이 남은 경우.
**해결** — `server/database/lock.dat` 파일을 삭제 후 다시 기동합니다. (이미 다른 서버 인스턴스가 떠 있지 않은지 먼저 확인)

```powershell
Remove-Item "D:\scouter\scouter-Tomcat9\server\database\lock.dat" -Force
```

---

## 8. 설치 체크리스트

- [ ] `scouter-all-2.21.3.tar.gz` 다운로드 및 압축 해제
- [ ] Server 기동 (`startup.sh` / `startup.bat`) 및 6100 포트 리슨 확인
- [ ] `agent.java/conf/scouter.conf` 에 `obj_name`·`net_collector_ip` 설정
- [ ] Tomcat `setenv` 에 `-javaagent` 등록
- [ ] Tomcat 재기동 후 `[Scouter]` 로그 확인
- [ ] (선택) Host Agent 기동
- [ ] Client 접속 → Object 트리에서 대상 인스턴스 확인
- [ ] 방화벽 포트 허용 / 기본 비밀번호 변경
```

