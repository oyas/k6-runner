/** @jsx jsx */
/** @jsxFrag Fragment */

import { Hono } from 'https://deno.land/x/hono/mod.ts'
import { serveStatic } from 'https://deno.land/x/hono/middleware.ts'
import { HTTPException } from 'https://deno.land/x/hono/http-exception.ts'
import { streamSSE } from 'https://deno.land/x/hono/helper.ts'
import { jsx, Fragment, FC } from 'https://deno.land/x/hono/middleware.ts'
import { walk } from "https://deno.land/std/fs/walk.ts";
import { basename } from "https://deno.land/std/path/mod.ts";
import { delay } from "https://deno.land/std/async/delay.ts";
import { decodeBase64 } from "https://deno.land/std/encoding/base64.ts";
import { ZodError, z } from "https://deno.land/x/zod/mod.ts";

const PORT = Deno.env.get("PORT") ?? '9000'
const k6DashboardHost = Deno.env.get("K6_DASHBOARD_HOST") ?? 'k6:5665'
const k6ApiHost = Deno.env.get("K6_API_HOST") ?? 'k6:6565'
const k6StartUrl = Deno.env.get("K6_START_URL") ?? 'http://k6:8000'
const outputDir = '/mnt/output'

const GITHUB_HOST = Deno.env.get("GITHUB_HOST") ?? 'github.com'
const GITHUB_API_BASE_URL = Deno.env.get("GITHUB_API_BASE_URL") ?? `https://api.github.com`

const Layout: FC = (props) => {
    return (
        <html>
            <head>
                <meta charset="utf-8" />
                <meta name="viewport" content="width=device-width, initial-scale=1" />
                <title>k6 runner</title>
                <style>{`
                    a {
                        text-decoration: none;
                    }
                    input {
                        width: 100%;
                    }
                    tr:nth-child(odd) {
                        background-color: #eee;
                    }
                    td {
                        padding: 10px;
                    }
                `}</style>
            </head>
            <body>
                <main style={{maxWidth: props.maxWidth, margin: "auto"}}>
                    {props.children}
                </main>
            </body>
        </html>
    )
}

type Status = "START" | "RUNNING" | "STOP" | "BUSY" | "ERROR"

type StatusResponse = {
    status: Status
}

type StartResponse = {
    status: Status
    metadata?: Metadata
}

const StartK6Request = z.object({
    owner: z.string().min(1),
    repo: z.string().min(1),
    commitHash: z.string().min(1),
    path: z.string().min(1),
    memo: z.string().default(""),
});
type StartK6Request = z.infer<typeof StartK6Request>;

type Metadata = {
    request: StartK6Request
    startedAt: number
    metadataPath: string
    reportPath: string
    stdoutPath: string
}

async function getK6Status(): Promise<Status> {
    try {
        const res = await fetch(`http://${k6ApiHost}/v1/status`)
        const json = await res.json()
        console.log(json)
        if (json.data.attributes.running) {
            return "RUNNING"
        } else {
            return "STOP"
        }
    } catch (e) {
        const stopStatusMessage = "Connection refused (os error 111)"
        if (e instanceof TypeError && e.message.includes(stopStatusMessage)) {
            return "STOP"
        } else {
            console.log(e.toString())
            return "ERROR"
        }
    }
}

async function startK6(): Promise<Status> {
    try {
        await fetch(k6StartUrl)
        return "START"
    } catch (e) {
        console.log(e.toString())
        return "ERROR"
    }
}

async function stopK6(): Promise<Status> {
    try {
        const body = {
            "data": {
                "type": "status",
                "id": "default",
                "attributes": {
                    "stopped": true
                }
            }
        }
        const res = await fetch(`http://${k6ApiHost}/v1/status`, {
            method: 'PATCH',
            headers: {
                "Content-Type": "application/json",
            },
            body: JSON.stringify(body),
        })
        const json = await res.json()
        console.log(json)
        if (json.data.attributes.stopped) {
            return "STOP"
        } else {
            return "ERROR"
        }
    } catch (e) {
        console.log(e.toString())
        return "ERROR"
    }
}

async function downloadScriptFromGitHub(githubToken: string, owner: string, repo: string, path: string, ref: string): Promise<string> {
    if (owner == "dummy" && repo == "dummy" && path == "dummy" && ref == "dummy") {
        // dummy script
        return `
            import http from 'k6/http';
            import { sleep } from 'k6';

            export const options = {
              vus: 1,
              duration: '10s',
            }

            export default function() {
              http.get('http://localhost:5665');
              sleep(1);
            }
        `
    }

    const response = await fetch(`${GITHUB_API_BASE_URL}/repos/${owner}/${repo}/contents/${path}?ref=${ref}`, {
        method: "GET",
        cache: "no-cache",
        headers: {
            "Accept": "application/vnd.github+json",
            "Authorization": `${githubToken}`,
        },
    })
    console.log("response.ok =", response.ok)
    if (!response.ok) {
        console.log(response)
        throw new Error(`${response.status} ${response.statusText}`)
    }
    let data = undefined
    try {
        data = await response.json()
    } catch (e) {
        console.log(e)
        throw e
    }
    const content = data.content.replace('\n', '')
    const base64Decoded = decodeBase64(content)
    const textDecoder = new TextDecoder()
    const decoded = textDecoder.decode(base64Decoded)
    console.log("decoded=", decoded)
    return decoded
}

let lastStarted = 0
async function startK6WithScript(githubToken: string, req: StartK6Request): Promise<StartResponse> {
    if (lastStarted > Date.now() - 10000) {
        return { status: "BUSY" }
    }
    lastStarted = Date.now()

    const stat = await getK6Status()
    if (stat == "RUNNING") {
        lastStarted = 0  // unlock
        return { status: "BUSY" }
    }

    const scriptPath = `/script-${lastStarted}.js`
    const metadataPath = `/reports/metadata-${lastStarted}.json`
    const reportPath = `/reports/report-${lastStarted}.html`
    const stdoutPath = `/reports/stdout-${lastStarted}.txt`
    const metadata: Metadata = {
        startedAt: lastStarted,
        request: req,
        metadataPath,
        reportPath,
        stdoutPath,
    }

    let script: string
    try {
        script = await downloadScriptFromGitHub(
            githubToken,
            req.owner,
            req.repo,
            req.path,
            req.commitHash,
        )
    } catch (e) {
        console.log(e)
        throw new HTTPException(500, {
            message: `Cannot download from GitHub: ${e.message}`,
            cause: e,
        })
    }

    const scriptLocalPath = `${outputDir}${scriptPath}`
    await Deno.writeTextFile(scriptLocalPath, script)
    const metadataLocalPath = `${outputDir}${metadataPath}`
    await Deno.writeTextFile(metadataLocalPath, JSON.stringify(metadata))
    const lastStartedPath = `${outputDir}/lastStarted`
    await Deno.writeTextFile(lastStartedPath, lastStarted.toString())

    const s = await startK6()

    for (let i = 0; i < 10; i++) {
        await delay(500)  // sleep 500 ms
        const stat = await getK6Status()
        console.log("waiting to start", i, stat)
        if (stat == "RUNNING") {
            lastStarted = 0  // unlock
            break
        }
    }

    return { status: s, metadata }
}

function menuPage(app: Hono) {
    const html = <Layout maxWidth="600px">
        <p style={{padding: "30px"}}>
            <a id="k6-status" href="/">Checking k6 status...</a>
        </p>
        <div style={{display: "grid", gridTemplateColumns: "130px 1fr", columnGap: "10px", rowGap: "10px"}}>
            <label for="token">GitHub Token</label>
            <input id="token" type="text" placeholder="token" />
            <label for="owner">Owner</label>
            <input id="owner" type="text" placeholder="owner" />
            <label for="repo">Repo</label>
            <input id="repo" type="text" placeholder="repo" />
            <label for="path">Path</label>
            <input id="path" type="text" placeholder="k6/script.js" />
            <label for="commitHash">CommitHash</label>
            <input id="commitHash" type="text" placeholder="000000000000000000000000001234567890abcd" />
            <label for="memo">MEMO</label>
            <input id="memo" type="text" />
        </div>
        <br />
        <div style={{display: "grid", columnGap: "10px", rowGap: "10px"}}>
            <p id="error" style={{color: "red"}}></p>
            <button type="button" id="startButton" style={{ width: "100%", padding: "10px" }}>▶️  Run k6 script</button>
            <button type="button" id="stopButton" style={{ width: "100%", padding: "10px" }}>⏹️  Stop k6 script</button>
            <a href="/reports/" style={{ width: "100%", padding: "5px" }}>📄  Reports</a>
        </div>
        <script type="module" src='/menu.js'></script>
    </Layout>
    const jsText = `
        const evtSource = new EventSource("/status?watch=true");
        evtSource.addEventListener("k6stasus", function (event) {
            // console.log(event)
            const el = document.querySelector("#k6-status");
            if (event.data == "RUNNING") {
                el.innerText = "🟢 k6 is running.";
            } else {
                el.innerText = "🟥 k6 is not running.";
            }
        });

        document.querySelector("#startButton").addEventListener("click", async () => {
            const token = document.querySelector("#token").value;
            const owner = document.querySelector("#owner").value;
            const repo = document.querySelector("#repo").value;
            const path = document.querySelector("#path").value;
            const commitHash = document.querySelector("#commitHash").value;
            const memo = document.querySelector("#memo").value;
            console.log("owner", owner);
            const response = await fetch("/start", {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "Authorization": "Bearer " + token,
                },
                body: JSON.stringify({
                    owner,
                    repo,
                    path,
                    commitHash,
                    memo,
                })
            });
            console.log(response);
            if (response.ok) {
                window.location = "/";
            } else {
                const el = document.querySelector("#error");
                try {
                    el.innerText = (await response.json()).error.message;
                } catch (e) {
                    console.log(e)
                    el.innerText = e.toString();
                }
            }
        });

        document.querySelector("#stopButton").addEventListener("click", async () => {
            const response = await fetch("/stop", {
                method: "POST"
            });
            console.log(response);
        });
    `
    app.get('/menu', (c) => c.render(html))
    app.get('/menu.js', (c) => c.text(jsText, 200, { "Content-type": "application/javascript" }))
}

function reports(app: Hono) {
    app.get('/reports', async (c) => {
        const reports = new Array<Metadata>()
        for await (const entry of walk(outputDir + "/reports")) {
            const filename = basename(entry.path)
            if (entry.isFile && filename.startsWith("metadata-")) {
                const raw = await Deno.readTextFile(entry.path)
                const metadata = JSON.parse(raw) as Metadata
                console.log(metadata)
                reports.push(metadata)
            }
        }
        reports.sort((a, b) => b.startedAt - a.startedAt)
        return c.render(<Layout maxWidth="100%">
            <a href="/menu">⬅️ Menu</a>
            <table style={{width: "100%", borderCollapse: "collapse"}}>
                {reports.map(m => {
                    const d = new Date(m.startedAt)
                    const githubText = `${m.request.memo} ([${m.request.commitHash?.substring(0,6)}] ${m.request.repo}/${m.request.path})`
                    const githubLink = `https://${GITHUB_HOST}/${m.request.owner}/${m.request.repo}/blob/${m.request.commitHash}/${m.request.path}`
                    return <tr>
                        <td><a href={m.reportPath}>📄 {d.toString()}</a></td>
                        <td><a href={m.stdoutPath}>stdout</a></td>
                        <td><a href={githubLink}>{githubText}</a></td>
                        <td><a href={m.metadataPath}>metadata</a></td>
                    </tr>
                })}
            </table>
        </Layout>)
    })
    app.get('/reports/', (c) => c.redirect('/reports'))
    app.get('/reports/*', serveStatic({
        root: outputDir,
        onNotFound: (path, c) => {
            console.log(`${path} is not found, you access ${c.req.path}`)
        },
    }))
    app.get('/reports/*', c => c.text("404 Not Found", 404))
}

function k6manager(app: Hono) {
    app.get('/status', async (c) => {
        console.log(new Date(), c.req.method, c.req.url)
        const { watch } = c.req.query()
        if (watch != null && (watch == "true" || watch == "")) {
            let id = 0
            return streamSSE(c, async (stream) => {
                let alive = true
                stream.onAbort(() => {
                    console.log('Stream Aborted!')
                    alive = false
                })
                while (alive) {
                    const s = await getK6Status()
                    await stream.writeSSE({
                        data: s,
                        event: 'k6stasus',
                        id: String(id++),
                    })
                    console.log(new Date(), id)
                    await stream.sleep(2000)
                }
            })
        } else {
            const s = await getK6Status()
            return c.json({status: s}, s == "ERROR" ? 500 : 200)
        }
    })

    app.post('/start', async (c) => {
        console.log(c)
        const githubToken = c.req.header('Authorization')
        if (githubToken == null) {
            throw new HTTPException(401, { message: "Authorization header is required." })
        }
        let body: StartK6Request
        try {
            body = StartK6Request.parse(await c.req.json())
        } catch (e) {
            console.log(e)
            if (e instanceof ZodError) {
                const issue = e.issues.at(0)
                const message = `${issue?.path.at(0)} : ${issue?.message}`
                throw new HTTPException(400, { message, cause: e })
            }
            throw new HTTPException(400, { message: 'parse failed.', cause: e })
        }
        console.log(new Date(), c.req.method, c.req.url, body)
        const sr = await startK6WithScript(githubToken, body)
        return c.json(sr, sr.status == "ERROR" ? 500 : 200)
    })

    app.post('/stop', async (c) => {
        console.log(new Date(), c.req.method, c.req.url)
        const s = await stopK6()
        return c.json({status: s}, s == "ERROR" ? 500 : 200)
    })
}

function proxyToK6(app: Hono) {
    app.get('/events', async (c) => {
        const aborter = new AbortController()
        const url = new URL(c.req.url)
        url.host = k6DashboardHost
        const response = await fetch(url, {redirect: 'manual', signal: aborter.signal })
        if (!response.ok) {
            return response
        }
        return streamSSE(c, async (stream) => {
            stream.onAbort(() => {
                console.log('Stream Aborted!')
                aborter.abort()
            })
            const textDecoder = new TextDecoder()
            for await (const chunk of response?.body ?? []) {
                await stream.write(chunk)
                const decoded = textDecoder.decode(chunk.slice(0, -1))
                // console.log(new Date(), decoded)
                if (/\nevent: stop\n/.test(decoded)) {
                    console.log("Stream stopped!")
                    break
                }
            }
        })
    })

    app.get('/v1/*', (c) => {
        const url = new URL(c.req.url)
        url.host = k6ApiHost
        console.log('proxy to', url)
        return fetch(url, { redirect: 'manual' })
    })
    app.get('*', (c) => {
        console.log(c.req)
        const url = new URL(c.req.url)
        url.host = k6DashboardHost
        console.log('proxy to', url)
        return fetch(url, { redirect: 'manual' })
    })
}

function main() {
    const app = new Hono()

    app.onError((err, c) => {
        console.log(err, c)
        if (err instanceof HTTPException) {
            return c.json({
                "error": {
                    "message": err.message,
                }
            }, err.status)
        }
        if (err instanceof TypeError) {
            if (c.req.path == "/") {
                return c.redirect('/menu', 307)
            }
            return c.text('Not Found', 404)
        }
        return c.text(err.toString(), 500)
    })

    menuPage(app)

    reports(app)

    k6manager(app)

    proxyToK6(app)

    Deno.serve({ port: PORT }, app.fetch)
}

main()
