import express from "express";
import bodyParser from "body-parser";
import dotenv from "dotenv";
import fetch from "node-fetch";
dotenv.config();

if (!process.env.DIFY_API_URL) throw new Error("DIFY API URL is required.");
function generateId() {
    let result = "";
    const characters =
        "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
    for (let i = 0; i < 29; i++) {
        result += characters.charAt(Math.floor(Math.random() * characters.length));
    }
    return result;
}
const app = express();
app.use(bodyParser.json({ limit: process.env.PAYLOAD_LIMIT }));
const botType = process.env.BOT_TYPE || "Chat";
const inputVariable = process.env.INPUT_VARIABLE || "";
const outputVariable = process.env.OUTPUT_VARIABLE || "";

// Logging utility function
function logRequest(label, details) {
    console.log(`\n${"=".repeat(80)}`);
    console.log(`[${new Date().toISOString()}] ${label}`);
    console.log(`${"=".repeat(80)}`);
    Object.entries(details).forEach(([key, value]) => {
        if (value !== null && value !== undefined) {
            console.log(`${key}: ${typeof value === "object" ? JSON.stringify(value, null, 2) : value}`);
        }
    });
}

let apiPath;
switch (botType) {
    case "Chat":
        apiPath = "/chat-messages";
        break;
    case "Completion":
        apiPath = "/completion-messages";
        break;
    case "Workflow":
        apiPath = "/workflows/run";
        break;
    default:
        throw new Error("Invalid bot type in the environment variable.");
}
var corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers":
        "DNT,User-Agent,X-Requested-With,If-Modified-Since,Cache-Control,Content-Type,Range,Authorization",
    "Access-Control-Max-Age": "86400",
};

app.use((req, res, next) => {
    res.set(corsHeaders);
    if (req.method === "OPTIONS") {
        return res.status(204).end();
    }

    // Generate unique request ID for tracking
    const requestId = `req-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    req.requestId = requestId;
    req.startTime = Date.now();

    // Log incoming request
    logRequest("INCOMING REQUEST", {
        "Request ID": requestId,
        "Method": req.method,
        "Path": req.path,
        "Query Parameters": Object.keys(req.query).length > 0 ? req.query : "none",
        "Headers": {
            "Content-Type": req.get("content-type"),
            "Authorization": req.get("authorization") ? "Bearer [REDACTED]" : "none",
            "User-Agent": req.get("user-agent"),
            "Host": req.get("host"),
        },
        "Client IP": req.ip,
        "Body Size": JSON.stringify(req.body).length + " bytes",
        "Body": req.body ? req.body : null,
    });

    // Log response when it's sent
    const originalSend = res.send;
    res.send = function (data) {
        const duration = Date.now() - req.startTime;
        logRequest("OUTGOING RESPONSE", {
            "Request ID": requestId,
            "Status Code": res.statusCode,
            "Duration": duration + " ms",
            "Response Size": typeof data === "string" ? data.length + " bytes" : "stream",
            "Content-Type": res.get("content-type"),
        });
        originalSend.call(this, data);
    };

    next();
});

app.get("/", (req, res) => {
    res.send(`
    <html>
      <head>
        <title>DIFY2OPENAI</title>
      </head>
      <body>
        <h1>Dify2OpenAI</h1>
        <p>Congratulations! Your project has been successfully deployed.</p>
      </body>
    </html>
  `);
});

app.get("/v1/models", (req, res) => {
    const models = {
        object: "list",
        data: [
            {
                id: process.env.MODELS_NAME || "dify",
                object: "model",
                owned_by: "dify",
                permission: null,
            },
        ],
    };
    res.json(models);
});

app.post("/v1/chat/completions", async (req, res) => {
    const authHeader =
        req.headers["authorization"] || req.headers["Authorization"];
    if (!authHeader) {
        return res.status(401).json({
            code: 401,
            errmsg: "Unauthorized.",
        });
    } else {
        const token = authHeader.split(" ")[1];
        if (!token) {
            return res.status(401).json({
                code: 401,
                errmsg: "Unauthorized.",
            });
        }
    }
    try {
        const data = req.body;
        const messages = data.messages;
        let queryString;
        if (botType === "Chat") {
            const lastMessage = messages[messages.length - 1];
            queryString = `here is our talk history:\n'''\n${messages
                .slice(0, -1)
                .map((message) => `${message.role}: ${message.content}`)
                .join("\n")}\n'''\n\nhere is my question:\n${lastMessage.content}`;
        } else if (botType === "Completion" || botType === "Workflow") {
            queryString = messages[messages.length - 1].content;
        }
        const stream = data.stream !== undefined ? data.stream : false;
        let requestBody;
        if (inputVariable) {
            requestBody = {
                inputs: { [inputVariable]: queryString },
                response_mode: "streaming",
                conversation_id: "",
                user: "apiuser",
                auto_generate_name: false,
            };
        } else {
            requestBody = {
                inputs: {},
                query: queryString,
                response_mode: "streaming",
                conversation_id: "",
                user: "apiuser",
                auto_generate_name: false,
            };
        }

        const difyUrl = process.env.DIFY_API_URL + apiPath;
        const difyMethod = "POST";
        const difyBody = JSON.stringify(requestBody);

        // Log outgoing Dify request
        logRequest("DIFY OUTGOING REQUEST", {
            "Request ID": req.requestId,
            "Dify Method": difyMethod,
            "Dify URL": difyUrl,
            "Dify Headers": {
                "Content-Type": "application/json",
                "Authorization": "Bearer [REDACTED]",
            },
            "Dify Body Size": difyBody.length + " bytes",
            "Dify Body": requestBody,
        });

        const difyRequestStartTime = Date.now();

        const resp = await fetch(difyUrl, {
            method: difyMethod,
            headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${authHeader.split(" ")[1]}`,
            },
            body: difyBody,
        });

        const difyResponseDuration = Date.now() - difyRequestStartTime;

        // Log Dify response metadata
        logRequest("DIFY INCOMING RESPONSE", {
            "Request ID": req.requestId,
            "Dify Status Code": resp.status,
            "Dify Status Text": resp.statusText,
            "Dify Response Duration": difyResponseDuration + " ms",
            "Dify Response Headers": {
                "Content-Type": resp.headers.get("content-type"),
                "Content-Length": resp.headers.get("content-length"),
            },
            "Dify Stream Mode": stream ? "enabled" : "disabled",
        });

        if (!resp.ok) {
            console.error(`\n[ERROR] Dify API returned status ${resp.status}: ${resp.statusText}`);
        }

        let isResponseEnded = false;

        if (stream) {
            res.setHeader("Content-Type", "text/event-stream");
            const stream = resp.body;
            let buffer = "";
            let isFirstChunk = true;

            stream.on("data", (chunk) => {
                buffer += chunk.toString();
                let lines = buffer.split("\n");

                for (let i = 0; i < lines.length - 1; i++) {
                    let line = lines[i].trim();

                    if (!line.startsWith("data:")) continue;
                    line = line.slice(5).trim();
                    let chunkObj;
                    try {
                        if (line.startsWith("{")) {
                            chunkObj = JSON.parse(line);
                        } else {
                            continue;
                        }
                    } catch (error) {
                        console.error("Error parsing chunk:", error);
                        continue;
                    }

                    if (
                        chunkObj.event === "message" ||
                        chunkObj.event === "agent_message" ||
                        chunkObj.event === "text_chunk"
                    ) {
                        let chunkContent;
                        if (chunkObj.event === "text_chunk") {
                            chunkContent = chunkObj.data.text;
                        } else {
                            chunkContent = chunkObj.answer;
                        }

                        if (isFirstChunk) {
                            chunkContent = chunkContent.trimStart();
                            isFirstChunk = false;
                        }
                        if (chunkContent !== "") {
                            const chunkId = `chatcmpl-${Date.now()}`;
                            const chunkCreated = chunkObj.created_at;

                            if (!isResponseEnded) {
                                res.write(
                                    "data: " +
                                    JSON.stringify({
                                        id: chunkId,
                                        object: "chat.completion.chunk",
                                        created: chunkCreated,
                                        model: data.model,
                                        choices: [
                                            {
                                                index: 0,
                                                delta: {
                                                    content: chunkContent,
                                                },
                                                finish_reason: null,
                                            },
                                        ],
                                    }) +
                                    "\n\n",
                                );
                            }
                        }
                    } else if (
                        chunkObj.event === "workflow_finished" ||
                        chunkObj.event === "message_end"
                    ) {
                        const chunkId = `chatcmpl-${Date.now()}`;
                        const chunkCreated = chunkObj.created_at;

                        logRequest("STREAM EVENT - COMPLETION", {
                            "Request ID": req.requestId,
                            "Event Type": chunkObj.event,
                            "Message Length": result.length,
                        });

                        if (!isResponseEnded) {
                            res.write(
                                "data: " +
                                JSON.stringify({
                                    id: chunkId,
                                    object: "chat.completion.chunk",
                                    created: chunkCreated,
                                    model: data.model,
                                    choices: [
                                        {
                                            index: 0,
                                            delta: {},
                                            finish_reason: "stop",
                                        },
                                    ],
                                }) +
                                "\n\n",
                            );
                        }
                        if (!isResponseEnded) {
                            res.write("data: [DONE]\n\n");
                        }

                        res.end();
                        isResponseEnded = true;
                    } else if (chunkObj.event === "agent_thought") {
                    } else if (chunkObj.event === "ping") {
                    } else if (chunkObj.event === "error") {
                        console.error(`Error: ${chunkObj.code}, ${chunkObj.message}`);
                        logRequest("STREAM EVENT - ERROR", {
                            "Request ID": req.requestId,
                            "Error Code": chunkObj.code,
                            "Error Message": chunkObj.message,
                        });
                        res
                            .status(500)
                            .write(
                                `data: ${JSON.stringify({ error: chunkObj.message })}\n\n`,
                            );

                        if (!isResponseEnded) {
                            res.write("data: [DONE]\n\n");
                        }

                        res.end();
                        isResponseEnded = true;
                    }
                }

                buffer = lines[lines.length - 1];
            });
        } else {
            let result = "";
            let usageData = "";
            let hasError = false;
            let messageEnded = false;
            let buffer = "";
            let skipWorkflowFinished = false;

            const stream = resp.body;
            stream.on("data", (chunk) => {
                buffer += chunk.toString();
                // console.log("Non-Stream Buffer: ", buffer || null);
                let lines = buffer.split("\n");

                for (let i = 0; i < lines.length - 1; i++) {
                    const line = lines[i].trim();
                    if (line === "") continue;
                    let chunkObj;
                    try {
                        const cleanedLine = line.replace(/^data: /, "").trim();
                        if (cleanedLine.startsWith("{") && cleanedLine.endsWith("}")) {
                            chunkObj = JSON.parse(cleanedLine);
                        } else {
                            continue;
                        }
                    } catch (error) {
                        console.error("Error parsing JSON:", error);
                        continue;
                    }

                    if (
                        chunkObj.event === "message" ||
                        chunkObj.event === "agent_message"
                    ) {
                        result += chunkObj.answer;
                        skipWorkflowFinished = true;
                    } else if (chunkObj.event === "message_end") {
                        messageEnded = true;
                        usageData = {
                            prompt_tokens: chunkObj.metadata.usage.prompt_tokens || 100,
                            completion_tokens:
                                chunkObj.metadata.usage.completion_tokens || 10,
                            total_tokens: chunkObj.metadata.usage.total_tokens || 110,
                        };
                    } else if (
                        chunkObj.event === "workflow_finished" &&
                        !skipWorkflowFinished
                    ) {
                        messageEnded = true;
                        const outputs = chunkObj.data.outputs;
                        if (outputVariable) {
                            result = outputs[outputVariable];
                        } else {
                            result = outputs;
                        }
                        result = String(result);
                        usageData = {
                            prompt_tokens: chunkObj.metadata?.usage?.prompt_tokens || 100,
                            completion_tokens:
                                chunkObj.metadata?.usage?.completion_tokens || 10,
                            total_tokens: chunkObj.data.total_tokens || 110,
                        };
                    } else if (chunkObj.event === "agent_thought") {
                    } else if (chunkObj.event === "ping") {
                    } else if (chunkObj.event === "error") {
                        console.error(`Error: ${chunkObj.code}, ${chunkObj.message}`);
                        hasError = true;
                        break;
                    }
                }

                buffer = lines[lines.length - 1];
            });

            stream.on("end", () => {
                const duration = Date.now() - req.startTime;
                if (hasError) {
                    logRequest("STREAM PROCESSING - ERROR", {
                        "Request ID": req.requestId,
                        "Duration": duration + " ms",
                        "Error": "An error occurred during stream processing",
                    });
                    res
                        .status(500)
                        .json({ error: "An error occurred while processing the request." });
                } else if (messageEnded) {
                    const formattedResponse = {
                        id: `chatcmpl-${generateId()}`,
                        object: "chat.completion",
                        created: Math.floor(Date.now() / 1000),
                        model: data.model,
                        choices: [
                            {
                                index: 0,
                                message: {
                                    role: "assistant",
                                    content: result.trim(),
                                },
                                logprobs: null,
                                finish_reason: "stop",
                            },
                        ],
                        usage: usageData,
                        system_fingerprint: "fp_2f57f81c11",
                    };
                    const jsonResponse = JSON.stringify(formattedResponse, null, 2);

                    logRequest("STREAM PROCESSING - COMPLETED", {
                        "Request ID": req.requestId,
                        "Duration": duration + " ms",
                        "Response Size": jsonResponse.length + " bytes",
                        "Model": data.model,
                        "Usage": usageData,
                    });

                    res.set("Content-Type", "application/json");
                    res.send(jsonResponse);
                } else {
                    logRequest("STREAM PROCESSING - UNEXPECTED END", {
                        "Request ID": req.requestId,
                        "Duration": duration + " ms",
                    });
                    res.status(500).json({ error: "Unexpected end of stream." });
                }
            });
        }
    } catch (error) {
        const duration = Date.now() - req.startTime;
        logRequest("ERROR IN REQUEST PROCESSING", {
            "Request ID": req.requestId,
            "Error Type": error.name,
            "Error Message": error.message,
            "Error Stack": error.stack,
            "Total Duration": duration + " ms",
            "Timestamp": new Date().toISOString(),
        });
        console.error("Error:", error);
    }
});

const server = app.listen(process.env.PORT || 3000);
server.timeout = 600000;
