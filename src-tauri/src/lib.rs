use serde::Deserialize;
use std::path::Path;
use std::sync::OnceLock;
use tokio::process::Command;

/// Everything a list row needs. Used where a handful of PRs are fetched by number or branch.
const QUEUE_FIELDS: &str = r#"
... on PullRequest {
  id number title url isDraft
  createdAt updatedAt additions deletions changedFiles
  headRefName baseRefName reviewDecision
  mergeQueueEntry { position state }
  author { login avatarUrl }
  repository { nameWithOwner }
  commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }
  stackEntry { position }
  stack { baseRefName entries(first: 100) { nodes { position pullRequest { state } } } }
}"#;

/// What `search` returns cheaply (~1.2 s per 100). Diff size, review decision, checks, queue and stack are what make a
/// search page take 8-14 s and 502 on big queues, so those come from `QUEUE_DETAIL_FIELDS` in parallel `nodes` batches.
const QUEUE_SEARCH_FIELDS: &str = r#"
... on PullRequest {
  id number title url isDraft
  createdAt updatedAt headRefName baseRefName
  author { login avatarUrl }
  repository { nameWithOwner }
}"#;

const QUEUE_DETAIL_FIELDS: &str = r#"
... on PullRequest {
  id additions deletions changedFiles reviewDecision
  mergeQueueEntry { position state }
  commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }
  stackEntry { position }
  stack { baseRefName entries(first: 100) { nodes { position pullRequest { state } } } }
}"#;

/// PRs per detail request: ~2 s for 25 at full fields; 50 occasionally hits the same gateway timeout as search.
const QUEUE_DETAIL_BATCH: usize = 25;

const MAX_MERGE_STATE_IDS: usize = 25;
/// 100 is GitHub's max for search; it adds only ~1 s per page versus 50 and halves page count for large queues.
const QUEUE_PAGE_SIZE: usize = 100;

const MAX_DIFF_FALLBACK_FILES: usize = 3000;
const SYSTEM_ONE_URL: &str = "https://openrouter.ai/api/v1/systemone";
const CHAT_URL: &str = "https://openrouter.ai/api/v1/chat/completions";
const MAX_GROUPING_REQUEST_BYTES: usize = 400_000;
const MAX_READINESS_STATE_BYTES: usize = 600_000;

static OPENROUTER_KEY: OnceLock<Option<String>> = OnceLock::new();

#[derive(Deserialize, Clone, Copy, Debug)]
#[serde(rename_all = "lowercase")]
enum QueueKind {
    Review,
    Mine,
    Involved,
}

#[derive(Deserialize, Clone, Copy)]
#[serde(rename_all = "lowercase")]
enum MergeMethod {
    Squash,
    Merge,
    Rebase,
}

#[derive(Deserialize)]
struct PullFile {
    filename: String,
    previous_filename: Option<String>,
    status: String,
    patch: Option<String>,
}

fn gh_binary() -> &'static str {
    ["/opt/homebrew/bin/gh", "/usr/local/bin/gh", "/usr/bin/gh"]
        .into_iter()
        .find(|candidate| Path::new(candidate).exists())
        .unwrap_or("gh")
}

const GH_MAX_CONCURRENT: usize = 12;
const GH_RETRY_DELAYS_MS: [u64; 3] = [400, 1_200, 3_000];
const GITHUB_API: &str = "https://api.github.com";
const GITHUB_TIMEOUT_SECS: u64 = 40;

/// gh's token, read once. Calling GitHub directly over one pooled HTTP/2 connection skips the ~440 ms `gh` process start
/// on every request; `gh` itself stays for the few porcelain commands (approve, close) and as the token source.
static GITHUB_TOKEN: tokio::sync::Mutex<Option<String>> = tokio::sync::Mutex::const_new(None);

async fn github_token() -> Result<String, String> {
    let mut cached = GITHUB_TOKEN.lock().await;
    if let Some(token) = cached.as_ref() {
        return Ok(token.clone());
    }
    let output = Command::new(gh_binary())
        .args(["auth", "token"])
        .env("GH_PROMPT_DISABLED", "1")
        .output()
        .await
        .map_err(|error| format!("could not run gh: {error}"))?;
    let token = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if !output.status.success() || token.is_empty() || token.contains(char::is_whitespace) {
        return Err("GitHub sign-in missing; run `gh auth login`".to_string());
    }
    *cached = Some(token.clone());
    Ok(token)
}

async fn forget_github_token() {
    *GITHUB_TOKEN.lock().await = None;
}

fn github_client() -> &'static reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(GITHUB_TIMEOUT_SECS))
            .user_agent(concat!("pr-review/", env!("CARGO_PKG_VERSION")))
            .pool_idle_timeout(std::time::Duration::from_secs(90))
            .build()
            .expect("github client")
    })
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Method {
    Get,
    Post,
    Put,
    Patch,
}

/// One GitHub API call with gh's token. Reads retry gateway timeouts and dropped connections; writes never retry.
async fn github(method: Method, path: &str, body: Option<serde_json::Value>, accept: Option<&str>) -> Result<String, String> {
    let is_read = method == Method::Get || body.as_ref().is_some_and(|value| value["query"].as_str().is_some_and(|query| !query.trim_start().starts_with("mutation")));
    let mut attempt = 0;
    let mut refreshed_token = false;
    loop {
        let result = {
            let _slot = GH_SLOTS.acquire().await.map_err(|error| error.to_string())?;
            github_once(method, path, body.as_ref(), accept).await
        };
        match result {
            Err(GithubError::Unauthorized) if !refreshed_token => {
                forget_github_token().await;
                refreshed_token = true;
            }
            Err(GithubError::Retryable(message)) if is_read && attempt < GH_RETRY_DELAYS_MS.len() => {
                eprintln!("[github] {path} -> {message}, retrying");
                tokio::time::sleep(std::time::Duration::from_millis(GH_RETRY_DELAYS_MS[attempt])).await;
                attempt += 1;
            }
            Err(error) => return Err(error.into_message()),
            Ok(text) => return Ok(text),
        }
    }
}

enum GithubError {
    Unauthorized,
    Retryable(String),
    Fatal(String),
}

impl GithubError {
    fn into_message(self) -> String {
        match self {
            GithubError::Unauthorized => "GitHub sign-in expired; run `gh auth login`".to_string(),
            GithubError::Retryable(message) | GithubError::Fatal(message) => message,
        }
    }
}

async fn github_once(method: Method, path: &str, body: Option<&serde_json::Value>, accept: Option<&str>) -> Result<String, GithubError> {
    let token = github_token().await.map_err(GithubError::Fatal)?;
    let url = format!("{GITHUB_API}/{}", path.trim_start_matches('/'));
    let builder = match method {
        Method::Get => github_client().get(&url),
        Method::Post => github_client().post(&url),
        Method::Put => github_client().put(&url),
        Method::Patch => github_client().patch(&url),
    };
    let mut request = builder
        .bearer_auth(token)
        .header("X-GitHub-Api-Version", "2022-11-28")
        .header("Accept", accept.unwrap_or("application/vnd.github+json"));
    if let Some(body) = body {
        request = request.header("Content-Type", "application/json").body(body.to_string());
    }
    let response = request.send().await.map_err(|error| {
        let is_transient = error.is_timeout() || error.is_connect() || error.is_request();
        let message = error.without_url().to_string();
        if is_transient { GithubError::Retryable(message) } else { GithubError::Fatal(message) }
    })?;
    let status = response.status();
    let text = response.text().await.map_err(|error| GithubError::Retryable(error.without_url().to_string()))?;
    if status.is_success() {
        return graphql_errors_only(&text).map_or(Ok(text), |message| Err(classify_graphql_error(message)));
    }
    let detail = serde_json::from_str::<serde_json::Value>(&text)
        .ok()
        .and_then(|value| value["message"].as_str().map(str::to_string))
        .unwrap_or_else(|| text.chars().take(200).collect());
    match status.as_u16() {
        401 => Err(GithubError::Unauthorized),
        502..=504 => Err(GithubError::Retryable(format!("HTTP {status}: {detail}"))),
        _ => Err(GithubError::Fatal(format!("HTTP {status}: {detail}"))),
    }
}

/// GraphQL reports failures in a 200 body. A response with no data at all is an error; partial data is returned as is.
fn graphql_errors_only(text: &str) -> Option<String> {
    let value: serde_json::Value = serde_json::from_str(text).ok()?;
    let message = value["errors"][0]["message"].as_str()?;
    value["data"].is_null().then(|| message.to_string())
}

fn classify_graphql_error(message: String) -> GithubError {
    let lower = message.to_ascii_lowercase();
    if lower.contains("timeout") || lower.contains("something went wrong") || lower.contains("try again") {
        GithubError::Retryable(message)
    } else {
        GithubError::Fatal(message)
    }
}

/// Mutations go through the same client; `github` sees the leading `mutation` and never retries them.
async fn graphql_mutation(query: &str, variables: serde_json::Value) -> Result<String, String> {
    debug_assert!(query.trim_start().starts_with("mutation"));
    graphql(query, variables).await
}

async fn graphql(query: &str, variables: serde_json::Value) -> Result<String, String> {
    github(Method::Post, "graphql", Some(serde_json::json!({ "query": query, "variables": variables })), None).await
}

static GH_SLOTS: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(GH_MAX_CONCURRENT);

fn is_safe_segment(segment: &str) -> bool {
    !segment.is_empty()
        && !segment.starts_with('-')
        && segment.len() <= 100
        && segment.chars().all(|character| character.is_ascii_alphanumeric() || matches!(character, '-' | '_' | '.'))
}

fn validate_repo(repo: &str) -> Result<(), String> {
    match repo.split_once('/') {
        Some((owner, name)) if is_safe_segment(owner) && is_safe_segment(name) => Ok(()),
        _ => Err(format!("invalid repository: {repo}")),
    }
}

fn search_query(kind: QueueKind) -> &'static str {
    match kind {
        QueueKind::Review => "is:pr is:open archived:false review-requested:@me sort:updated-desc",
        QueueKind::Mine => "is:pr is:open archived:false author:@me sort:updated-desc",
        QueueKind::Involved => "is:pr is:open archived:false involves:@me sort:updated-desc",
    }
}

#[tauri::command]
async fn queue(kind: QueueKind) -> Result<String, String> {
    let search = format!(
        "query($q: String!, $cursor: String) {{ search(query: $q, type: ISSUE, first: {QUEUE_PAGE_SIZE}, after: $cursor) {{ issueCount pageInfo {{ hasNextPage endCursor }} nodes {{ {QUEUE_SEARCH_FIELDS} }} }} }}"
    );
    let detail = format!("query($ids: [ID!]!) {{ nodes(ids: $ids) {{ {QUEUE_DETAIL_FIELDS} }} }}");
    let mut nodes: Vec<serde_json::Value> = Vec::new();
    let mut details = tokio::task::JoinSet::new();
    let mut cursor: Option<String> = None;
    // Detail batches start as soon as each search page lands, so they overlap the remaining pages.
    loop {
        let page: serde_json::Value = serde_json::from_str(&graphql(&search, serde_json::json!({ "q": search_query(kind), "cursor": cursor })).await?)
            .map_err(|error| format!("invalid search response: {error}"))?;
        let result = &page["data"]["search"];
        let page_nodes: Vec<serde_json::Value> = result["nodes"].as_array().cloned().unwrap_or_default().into_iter().filter(|node| node["id"].is_string()).collect();
        let ids: Vec<String> = page_nodes.iter().filter_map(|node| node["id"].as_str().map(str::to_string)).collect();
        for batch in ids.chunks(QUEUE_DETAIL_BATCH) {
            let (query, ids) = (detail.clone(), batch.to_vec());
            details.spawn(async move { graphql(&query, serde_json::json!({ "ids": ids })).await });
        }
        nodes.extend(page_nodes);
        cursor = result["pageInfo"]["endCursor"].as_str().map(str::to_string);
        if result["pageInfo"]["hasNextPage"].as_bool() != Some(true) || cursor.is_none() {
            break;
        }
    }
    let mut by_id: std::collections::HashMap<String, serde_json::Value> = std::collections::HashMap::new();
    let mut failures = 0;
    while let Some(joined) = details.join_next().await {
        let Ok(Ok(text)) = joined else {
            failures += 1;
            continue;
        };
        let parsed: serde_json::Value = serde_json::from_str(&text).unwrap_or_default();
        for node in parsed["data"]["nodes"].as_array().into_iter().flatten() {
            if let Some(id) = node["id"].as_str() {
                by_id.insert(id.to_string(), node.clone());
            }
        }
    }
    if failures > 0 {
        eprintln!("[github] queue: {failures} detail batch(es) failed after retries; those rows show without checks or size");
    }
    let merged: Vec<serde_json::Value> = nodes
        .into_iter()
        .map(|mut node| {
            let extra = node_detail(&by_id, &node);
            if let (Some(target), Some(extra)) = (node.as_object_mut(), extra) {
                for (key, value) in extra {
                    target.insert(key, value);
                }
            }
            node
        })
        .collect();
    Ok(serde_json::json!([{ "data": { "search": { "nodes": merged } } }]).to_string())
}

fn node_detail(by_id: &std::collections::HashMap<String, serde_json::Value>, node: &serde_json::Value) -> Option<serde_json::Map<String, serde_json::Value>> {
    by_id.get(node["id"].as_str()?)?.as_object().cloned()
}

fn is_node_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 64 && id.chars().all(|character| character.is_ascii_alphanumeric() || matches!(character, '_' | '-' | '='))
}

#[tauri::command]
async fn merge_states(ids: Vec<String>) -> Result<String, String> {
    if ids.is_empty() || ids.len() > MAX_MERGE_STATE_IDS || !ids.iter().all(|id| is_node_id(id)) {
        return Err("invalid pull request ids".to_string());
    }
    // isRequired needs the PR id as an argument, so each PR gets its own aliased field.
    let fields: Vec<String> = ids.iter().enumerate().map(|(index, id)| format!(
        "p{index}: node(id: \"{id}\") {{ ... on PullRequest {{ id mergeable mergeStateStatus reviewThreads(first: 100) {{ nodes {{ isResolved isOutdated }} }} commits(last: 1) {{ nodes {{ commit {{ statusCheckRollup {{ contexts(first: 100) {{ nodes {{ __typename ... on CheckRun {{ name conclusion isRequired(pullRequestId: \"{id}\") }} ... on StatusContext {{ context state isRequired(pullRequestId: \"{id}\") }} }} }} }} }} }} }} }} }}"
    )).collect();
    let query = format!("query {{ {} }}", fields.join(" "));
    graphql(&query, serde_json::json!({})).await
}

fn is_safe_branch(branch: &str) -> bool {
    !branch.is_empty() && branch.len() <= 255 && !branch.chars().any(|character| character.is_control())
}

#[tauri::command]
async fn pull(repo: String, number: u64) -> Result<String, String> {
    validate_repo(&repo)?;
    let (owner, name) = repo.split_once('/').ok_or("invalid repository")?;
    let query = format!("query($owner: String!, $name: String!, $number: Int!) {{ repository(owner: $owner, name: $name) {{ pullRequest(number: $number) {{ state {QUEUE_FIELDS} stack {{ baseRefName entries(first: 100) {{ nodes {{ position pullRequest {{ state {QUEUE_FIELDS} }} }} }} }} }} }} }}");
    graphql(&query, serde_json::json!({ "owner": owner, "name": name, "number": number })).await
}

/// Open pulls stacked directly on `head` (above) and the open pull whose head is `base` (below).
#[tauri::command]
async fn stack_neighbors(repo: String, head: String, base: String) -> Result<String, String> {
    validate_repo(&repo)?;
    if !is_safe_branch(&head) || !is_safe_branch(&base) {
        return Err("invalid branch".to_string());
    }
    let (owner, name) = repo.split_once('/').ok_or("invalid repository")?;
    let query = format!("query($owner: String!, $name: String!, $head: String!, $base: String!) {{ repository(owner: $owner, name: $name) {{ above: pullRequests(baseRefName: $head, states: OPEN, first: 20) {{ nodes {{ {QUEUE_FIELDS} }} }} below: pullRequests(headRefName: $base, states: OPEN, first: 5) {{ nodes {{ {QUEUE_FIELDS} }} }} }} }}");
    graphql(&query, serde_json::json!({ "owner": owner, "name": name, "head": head, "base": base })).await
}

#[tauri::command]
async fn threads(repo: String, number: u64) -> Result<String, String> {
    validate_repo(&repo)?;
    let (owner, name) = repo.split_once('/').ok_or("invalid repository")?;
    let query = "query($owner: String!, $name: String!, $number: Int!) { repository(owner: $owner, name: $name) { pullRequest(number: $number) { reviewThreads(first: 100) { nodes { id isResolved isOutdated path line originalLine diffSide viewerCanResolve comments(first: 30) { totalCount nodes { id bodyHTML createdAt url author { login avatarUrl __typename } } } } } } } }";
    graphql(query, serde_json::json!({ "owner": owner, "name": name, "number": number })).await
}

/// Takes a pull out of its merge queue. GitHub has no REST endpoint for this, only the GraphQL mutation.
#[tauri::command]
async fn dequeue(pull_id: String) -> Result<String, String> {
    if !is_node_id(&pull_id) {
        return Err("invalid pull request id".to_string());
    }
    let query = "mutation($id: ID!) { dequeuePullRequest(input: { id: $id }) { mergeQueueEntry { id } } }";
    let output = graphql(query, serde_json::json!({ "id": pull_id })).await?;
    let parsed: serde_json::Value = serde_json::from_str(&output).map_err(|error| error.to_string())?;
    if let Some(message) = parsed["errors"][0]["message"].as_str() {
        return Err(message.to_string());
    }
    Ok("dequeued".to_string())
}

#[tauri::command]
async fn set_thread_resolved(thread_id: String, resolved: bool) -> Result<String, String> {
    if !is_node_id(&thread_id) {
        return Err("invalid thread id".to_string());
    }
    let mutation = if resolved { "resolveReviewThread" } else { "unresolveReviewThread" };
    let query = format!("mutation($id: ID!) {{ {mutation}(input: {{ threadId: $id }}) {{ thread {{ id isResolved }} }} }}");
    graphql_mutation(&query, serde_json::json!({ "id": thread_id })).await
}

#[tauri::command]
async fn reply_to_thread(thread_id: String, body: String) -> Result<String, String> {
    if !is_node_id(&thread_id) {
        return Err("invalid thread id".to_string());
    }
    if body.trim().is_empty() || body.len() > MAX_COMMENT_BYTES {
        return Err("reply must be between 1 and 65000 bytes".to_string());
    }
    let query = "mutation($id: ID!, $body: String!) { addPullRequestReviewThreadReply(input: { pullRequestReviewThreadId: $id, body: $body }) { comment { id } } }";
    graphql_mutation(query, serde_json::json!({ "id": thread_id, "body": body })).await
}

#[tauri::command]
async fn conversation(repo: String, number: u64) -> Result<String, String> {
    validate_repo(&repo)?;
    let (owner, name) = repo.split_once('/').ok_or("invalid repository")?;
    let query = "query($owner: String!, $name: String!, $number: Int!) { repository(owner: $owner, name: $name) { pullRequest(number: $number) { comments(last: 50) { totalCount nodes { id bodyHTML createdAt url author { login avatarUrl __typename } } } reviews(last: 30) { totalCount nodes { id state bodyHTML submittedAt url author { login avatarUrl __typename } comments { totalCount } } } } } }";
    graphql(query, serde_json::json!({ "owner": owner, "name": name, "number": number })).await
}

#[tauri::command]
async fn body(repo: String, number: u64) -> Result<String, String> {
    validate_repo(&repo)?;
    let (owner, name) = repo.split_once('/').ok_or("invalid repository")?;
    let query = "query($owner: String!, $name: String!, $number: Int!) { repository(owner: $owner, name: $name) { pullRequest(number: $number) { bodyHTML } } }";
    let output = graphql(query, serde_json::json!({ "owner": owner, "name": name, "number": number })).await?;
    let parsed: serde_json::Value = serde_json::from_str(&output).map_err(|error| error.to_string())?;
    Ok(parsed["data"]["repository"]["pullRequest"]["bodyHTML"].as_str().unwrap_or("").to_string())
}

#[tauri::command]
async fn diff(repo: String, number: u64) -> Result<String, String> {
    validate_repo(&repo)?;
    let path = format!("repos/{repo}/pulls/{number}");
    match github(Method::Get, &path, None, Some("application/vnd.github.v3.diff")).await {
        Ok(patch) => Ok(patch),
        Err(error) if error.contains("too_large") || error.contains("406") || error.contains("exceeded") => {
            diff_from_files(&repo, number).await
        }
        Err(error) => Err(error),
    }
}

async fn diff_from_files(repo: &str, number: u64) -> Result<String, String> {
    let mut files: Vec<PullFile> = Vec::new();
    // GitHub lists at most 3000 files, 100 per page.
    for page in 1..=30 {
        let raw = github(Method::Get, &format!("repos/{repo}/pulls/{number}/files?per_page=100&page={page}"), None, None).await?;
        let batch: Vec<PullFile> = serde_json::from_str(&raw).map_err(|error| error.to_string())?;
        let is_last = batch.len() < 100;
        files.extend(batch);
        if is_last {
            break;
        }
    }
    let patch = files
        .into_iter()
        .take(MAX_DIFF_FALLBACK_FILES)
        .map(|file| file_patch(&file))
        .collect::<Vec<_>>()
        .join("");
    Ok(patch)
}

fn file_patch(file: &PullFile) -> String {
    let old_name = file.previous_filename.as_deref().unwrap_or(&file.filename);
    let (old_path, new_path) = match file.status.as_str() {
        "added" => ("/dev/null".to_string(), format!("b/{}", file.filename)),
        "removed" => (format!("a/{old_name}"), "/dev/null".to_string()),
        _ => (format!("a/{old_name}"), format!("b/{}", file.filename)),
    };
    let body = file.patch.as_deref().unwrap_or("");
    let rename = if file.status == "renamed" {
        format!("rename from {old_name}\nrename to {}\n", file.filename)
    } else {
        String::new()
    };
    let hunks = if body.is_empty() { String::new() } else { format!("--- {old_path}\n+++ {new_path}\n{body}\n") };
    format!("diff --git a/{old_name} b/{}\n{rename}{hunks}", file.filename)
}

#[tauri::command]
async fn approve(repo: String, number: u64) -> Result<String, String> {
    validate_repo(&repo)?;
    github(Method::Post, &format!("repos/{repo}/pulls/{number}/reviews"), Some(serde_json::json!({ "event": "APPROVE" })), None).await.map(|_| "approved".to_string())
}

const MAX_COMMENT_BYTES: usize = 65_000;

#[tauri::command]
async fn close(repo: String, number: u64, comment: Option<String>) -> Result<String, String> {
    validate_repo(&repo)?;
    let comment = comment.filter(|body| !body.trim().is_empty());
    if comment.as_ref().is_some_and(|body| body.len() > MAX_COMMENT_BYTES) {
        return Err("comment must be at most 65000 bytes".to_string());
    }
    // Same order as `gh pr close --comment`: the comment first, so it lands on the PR even if closing then fails.
    if let Some(body) = comment {
        github(Method::Post, &format!("repos/{repo}/issues/{number}/comments"), Some(serde_json::json!({ "body": body })), None).await?;
    }
    github(Method::Patch, &format!("repos/{repo}/pulls/{number}"), Some(serde_json::json!({ "state": "closed" })), None).await.map(|_| "closed".to_string())
}

#[tauri::command]
async fn comment(repo: String, number: u64, body: String) -> Result<String, String> {
    validate_repo(&repo)?;
    if body.trim().is_empty() || body.len() > MAX_COMMENT_BYTES {
        return Err("comment must be between 1 and 65000 bytes".to_string());
    }
    let path = format!("repos/{repo}/issues/{number}/comments");
    let output = github(Method::Post, &path, Some(serde_json::json!({ "body": body })), None).await?;
    let parsed: serde_json::Value = serde_json::from_str(&output).map_err(|error| error.to_string())?;
    Ok(parsed["html_url"].as_str().unwrap_or("").to_string())
}

fn devin_binary() -> String {
    let home = std::env::var("HOME").unwrap_or_default();
    [format!("{home}/.local/bin/devin"), "/opt/homebrew/bin/devin".to_string(), "/usr/local/bin/devin".to_string()]
        .into_iter()
        .find(|candidate| Path::new(candidate).exists())
        .unwrap_or_else(|| "devin".to_string())
}

const DEVIN_LOAD_TIMEOUT_SECS: u64 = 60;
const DEVIN_DELIVERY_TIMEOUT_SECS: u64 = 30;

#[derive(Clone, Debug, PartialEq, Eq)]
struct DevinCredentials {
    api_key: String,
    api_url: String,
}

static DEVIN_ORG: tokio::sync::Mutex<Option<(String, String, String)>> = tokio::sync::Mutex::const_new(None);

fn parse_toml_string(raw: &str) -> Option<String> {
    let trimmed = raw.trim();
    let inner = trimmed.strip_prefix('"')?.strip_suffix('"')?;
    Some(inner.replace("\\\"", "\"").replace("\\\\", "\\"))
}

fn parse_devin_credentials(contents: &str) -> Option<DevinCredentials> {
    let mut api_key = None;
    let mut api_url = None;
    for line in contents.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with('#') || trimmed.starts_with('[') {
            continue;
        }
        let Some((key, value)) = trimmed.split_once('=') else { continue };
        match key.trim() {
            "windsurf_api_key" => api_key = parse_toml_string(value).filter(|text| !text.is_empty()),
            "devin_api_url" => api_url = parse_toml_string(value).filter(|text| text.starts_with("https://")),
            _ => {}
        }
    }
    Some(DevinCredentials {
        api_key: api_key?,
        api_url: api_url.unwrap_or_else(|| "https://api.devin.ai".to_string()).trim_end_matches('/').to_string(),
    })
}

fn read_devin_credentials() -> Option<DevinCredentials> {
    let mut candidates = Vec::new();
    if let Ok(xdg) = std::env::var("XDG_DATA_HOME") {
        if !xdg.is_empty() {
            candidates.push(std::path::PathBuf::from(xdg).join("devin/credentials.toml"));
        }
    }
    if let Ok(home) = std::env::var("HOME") {
        if !home.is_empty() {
            candidates.push(std::path::PathBuf::from(&home).join(".local/share/devin/credentials.toml"));
            candidates.push(std::path::PathBuf::from(&home).join("Library/Application Support/devin/credentials.toml"));
        }
    }
    candidates
        .into_iter()
        .find_map(|path| std::fs::read_to_string(path).ok().and_then(|text| parse_devin_credentials(&text)))
}

fn extract_devin_org_id(body: &serde_json::Value) -> Option<String> {
    let org = body
        .get("devin_sessions_org_id")
        .and_then(serde_json::Value::as_str)
        .or_else(|| body.get("org_id").and_then(serde_json::Value::as_str))?;
    let is_safe = !org.is_empty() && org.len() <= 128 && org.chars().all(|character| character.is_ascii_alphanumeric() || matches!(character, '_' | '-'));
    is_safe.then(|| org.to_string())
}

async fn resolve_devin_org_id(credentials: &DevinCredentials) -> Result<String, String> {
    let mut cached = DEVIN_ORG.lock().await;
    if let Some((cached_url, cached_key, org_id)) = cached.as_ref() {
        if cached_url == &credentials.api_url && cached_key == &credentials.api_key {
            return Ok(org_id.clone());
        }
    }
    let response = http_client()
        .get(format!("{}/v3/self", credentials.api_url))
        .bearer_auth(&credentials.api_key)
        .send()
        .await
        .map_err(|error| format!("Devin API error: {}", error.without_url()))?;
    let status = response.status();
    let text = response.text().await.map_err(|error| error.without_url().to_string())?;
    if status.as_u16() == 401 || status.as_u16() == 403 {
        *cached = None;
        return Err("Devin sign-in failed; run `devin auth login`".to_string());
    }
    if !status.is_success() {
        return Err(format!("Devin /v3/self returned {status}"));
    }
    let parsed: serde_json::Value = serde_json::from_str(&text).map_err(|error| format!("invalid Devin /v3/self response: {error}"))?;
    let org_id = extract_devin_org_id(&parsed).ok_or("Devin /v3/self did not return an org_id")?;
    *cached = Some((credentials.api_url.clone(), credentials.api_key.clone(), org_id.clone()));
    Ok(org_id)
}

/// Posts directly to Devin's v3 REST API (~200 ms) instead of replaying the full session transcript over `devin acp --cloud` (20-60 s).
async fn message_devin_http(credentials: &DevinCredentials, session_id: &str, message: &str) -> Result<String, String> {
    let org_id = resolve_devin_org_id(credentials).await?;
    let url = format!("{}/v3/organizations/{org_id}/sessions/{}/messages", credentials.api_url, session_id.to_ascii_lowercase());
    let payload = serde_json::json!({ "message": message }).to_string();
    let response = http_client()
        .post(&url)
        .bearer_auth(&credentials.api_key)
        .header("Content-Type", "application/json")
        .body(payload)
        .send()
        .await
        .map_err(|error| format!("Devin API error: {}", error.without_url()))?;
    let status = response.status();
    let text = response.text().await.map_err(|error| error.without_url().to_string())?;
    if status.is_success() {
        return Ok("delivered".to_string());
    }
    if status.as_u16() == 401 || status.as_u16() == 403 {
        *DEVIN_ORG.lock().await = None;
        return Err("Devin sign-in failed; run `devin auth login`".to_string());
    }
    let detail = serde_json::from_str::<serde_json::Value>(&text)
        .ok()
        .and_then(|value| value.get("detail").and_then(serde_json::Value::as_str).map(str::to_string))
        .unwrap_or_else(|| text.chars().take(200).collect());
    Err(format!("Devin rejected the message ({status}): {detail}"))
}

async fn acp_send(stdin: &mut tokio::process::ChildStdin, id: u64, method: &str, params: serde_json::Value) -> Result<(), String> {
    use tokio::io::AsyncWriteExt;
    let line = serde_json::json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params }).to_string() + "\n";
    stdin.write_all(line.as_bytes()).await.map_err(|error| format!("devin acp write failed: {error}"))?;
    stdin.flush().await.map_err(|error| format!("devin acp write failed: {error}"))
}

async fn acp_await_delivery(lines: &mut tokio::io::Lines<tokio::io::BufReader<tokio::process::ChildStdout>>, prompt_id: u64, text: &str) -> Result<(), String> {
    let needle: String = text.chars().take(80).collect();
    while let Some(line) = lines.next_line().await.map_err(|error| error.to_string())? {
        let Ok(message) = serde_json::from_str::<serde_json::Value>(&line) else { continue };
        if message.get("id").and_then(serde_json::Value::as_u64) == Some(prompt_id) {
            if let Some(error) = message.get("error") {
                return Err(error.get("message").and_then(serde_json::Value::as_str).unwrap_or("unknown error").to_string());
            }
            return Ok(());
        }
        let update = &message["params"]["update"];
        let is_echo = update["sessionUpdate"] == "user_message_chunk" && update["content"]["text"].as_str().is_some_and(|echoed| echoed.contains(needle.as_str()));
        if is_echo {
            return Ok(());
        }
    }
    Err("devin acp closed before confirming delivery".to_string())
}

async fn acp_await_response(lines: &mut tokio::io::Lines<tokio::io::BufReader<tokio::process::ChildStdout>>, id: u64) -> Result<serde_json::Value, String> {
    while let Some(line) = lines.next_line().await.map_err(|error| error.to_string())? {
        let Ok(message) = serde_json::from_str::<serde_json::Value>(&line) else { continue };
        if message.get("id").and_then(serde_json::Value::as_u64) != Some(id) {
            continue;
        }
        if let Some(error) = message.get("error") {
            let text = error.get("message").and_then(serde_json::Value::as_str).unwrap_or("unknown error");
            return Err(text.to_string());
        }
        return Ok(message.get("result").cloned().unwrap_or(serde_json::Value::Null));
    }
    Err("devin acp closed the connection".to_string())
}

async fn message_devin_acp(session_id: &str, message: &str) -> Result<String, String> {
    let workdir = std::env::temp_dir().join("pr-review-devin");
    std::fs::create_dir_all(&workdir).map_err(|error| error.to_string())?;
    let workdir_text = workdir.to_string_lossy().to_string();
    let mut child = Command::new(devin_binary())
        .args(["acp", "--cloud"])
        .current_dir(&workdir)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .kill_on_drop(true)
        .spawn()
        .map_err(|error| format!("could not run devin: {error}"))?;
    let mut stdin = child.stdin.take().ok_or("devin acp has no stdin")?;
    let stdout = child.stdout.take().ok_or("devin acp has no stdout")?;
    let mut lines = tokio::io::AsyncBufReadExt::lines(tokio::io::BufReader::new(stdout));
    let acp_session = format!("devin-{}", session_id.to_ascii_lowercase());
    let handshake = async {
        acp_send(&mut stdin, 1, "initialize", serde_json::json!({ "protocolVersion": 1, "clientCapabilities": { "fs": { "readTextFile": false, "writeTextFile": false }, "terminal": false }, "clientInfo": { "name": "pr-review", "version": env!("CARGO_PKG_VERSION") } })).await?;
        acp_await_response(&mut lines, 1).await.map_err(|error| format!("Devin sign-in failed ({error}); run `devin auth login`"))?;
        acp_send(&mut stdin, 2, "session/load", serde_json::json!({ "sessionId": acp_session, "cwd": workdir_text, "mcpServers": [] })).await?;
        acp_await_response(&mut lines, 2).await.map_err(|error| format!("Devin couldn't open session {session_id}: {error}"))?;
        acp_send(&mut stdin, 3, "session/prompt", serde_json::json!({ "sessionId": acp_session, "prompt": [{ "type": "text", "text": message }] })).await
    };
    tokio::time::timeout(std::time::Duration::from_secs(DEVIN_LOAD_TIMEOUT_SECS), handshake)
        .await
        .map_err(|_| format!("timed out after {DEVIN_LOAD_TIMEOUT_SECS}s reaching Devin"))??;
    let delivery = tokio::time::timeout(std::time::Duration::from_secs(DEVIN_DELIVERY_TIMEOUT_SECS), acp_await_delivery(&mut lines, 3, message.trim())).await;
    drop(stdin);
    let _ = child.kill().await;
    match delivery {
        Ok(Ok(())) => Ok("delivered".to_string()),
        Ok(Err(error)) => Err(format!("Devin rejected the message: {error}")),
        Err(_) => Err(format!("sent, but Devin didn't confirm within {DEVIN_DELIVERY_TIMEOUT_SECS}s; check the session")),
    }
}

#[tauri::command]
async fn message_devin(session_id: String, message: String) -> Result<String, String> {
    let is_valid_session = (16..=64).contains(&session_id.len()) && session_id.chars().all(|character| character.is_ascii_hexdigit());
    if !is_valid_session {
        return Err("invalid Devin session id".to_string());
    }
    if message.trim().is_empty() || message.len() > MAX_COMMENT_BYTES {
        return Err("message must be between 1 and 65000 bytes".to_string());
    }
    let credentials = tauri::async_runtime::spawn_blocking(read_devin_credentials).await.ok().flatten();
    if let Some(credentials) = credentials {
        return message_devin_http(&credentials, &session_id, &message).await;
    }
    message_devin_acp(&session_id, &message).await
}

#[tauri::command]
async fn viewer() -> Result<String, String> {
    let output = github(Method::Get, "user", None, None).await?;
    let parsed: serde_json::Value = serde_json::from_str(&output).map_err(|error| error.to_string())?;
    Ok(parsed["login"].as_str().unwrap_or("").to_string())
}

#[tauri::command]
async fn merge_queue(repo: String, base: String) -> Result<String, String> {
    validate_repo(&repo)?;
    if base.is_empty() || base.len() > 255 || base.starts_with('-') || base.chars().any(|character| character.is_whitespace() || character.is_control()) {
        return Err("invalid base branch".to_string());
    }
    let (owner, name) = repo.split_once('/').ok_or("invalid repository")?;
    let query = "query($owner: String!, $name: String!, $branch: String!) { repository(owner: $owner, name: $name) { mergeQueue(branch: $branch) { url configuration { mergeMethod } } } }";
    graphql(query, serde_json::json!({ "owner": owner, "name": name, "branch": base })).await
}

#[tauri::command]
async fn merge(repo: String, number: u64, method: MergeMethod, queued: bool) -> Result<String, String> {
    validate_repo(&repo)?;
    // The async endpoint is the only one GitHub accepts for stacked pulls; it lands every open pull below this one into the stack's base.
    let path = format!("repos/{repo}/pulls/{number}/merge-async");
    let method = match method {
        MergeMethod::Squash => "squash",
        MergeMethod::Merge => "merge",
        MergeMethod::Rebase => "rebase",
    };
    let payload = if queued { serde_json::json!({ "merge_action": "merge_queue" }) } else { serde_json::json!({ "merge_action": "default", "merge_method": method }) };
    let output = github(Method::Put, &path, Some(payload), None).await?;
    let parsed: serde_json::Value = serde_json::from_str(&output).map_err(|error| error.to_string())?;
    match parsed["status"].as_str() {
        Some("failed") => Err(parsed["details"]["message"].as_str().unwrap_or("Merge failed").to_string()),
        Some(status) => Ok(status.to_string()),
        None => Err("Unexpected merge response".to_string()),
    }
}

fn resolve_openrouter_key() -> Option<String> {
    if let Ok(key) = std::env::var("OPENROUTER_API_KEY") {
        if !key.trim().is_empty() {
            return Some(key.trim().to_string());
        }
    }
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string());
    let output = std::process::Command::new(shell)
        .args(["-l", "-i", "-c", "printf %s \"$OPENROUTER_API_KEY\""])
        .stdin(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .output()
        .ok()?;
    let key = String::from_utf8(output.stdout).ok()?.trim().to_string();
    (key.starts_with("sk-") && !key.contains(char::is_whitespace)).then_some(key)
}

fn openrouter_key() -> Option<&'static str> {
    OPENROUTER_KEY.get_or_init(resolve_openrouter_key).as_deref()
}

#[tauri::command]
async fn review_context(repo: String, number: u64) -> Result<String, String> {
    validate_repo(&repo)?;
    let (owner, name) = repo.split_once('/').ok_or("invalid repository")?;
    let query = "query($owner: String!, $name: String!, $number: Int!) { repository(owner: $owner, name: $name) { pullRequest(number: $number) { body files(first: 100) { totalCount nodes { path additions deletions } } reviews(last: 20) { nodes { state bodyText submittedAt author { login __typename } } } comments(last: 25) { nodes { bodyText createdAt author { login __typename } } } reviewThreads(last: 100) { nodes { isResolved isOutdated } } } } }";
    graphql(query, serde_json::json!({ "owner": owner, "name": name, "number": number })).await
}

#[tauri::command]
async fn readiness_available() -> bool {
    tauri::async_runtime::spawn_blocking(|| openrouter_key().is_some()).await.unwrap_or(false)
}

#[tauri::command]
async fn readiness(request: String) -> Result<String, String> {
    if request.len() > MAX_READINESS_STATE_BYTES {
        return Err("readiness request too large".to_string());
    }
    let key = tauri::async_runtime::spawn_blocking(openrouter_key)
        .await
        .map_err(|error| error.to_string())?
        .ok_or("OPENROUTER_API_KEY not configured")?;
    let response = http_client()
        .post(SYSTEM_ONE_URL)
        .bearer_auth(key)
        .header("Content-Type", "application/json")
        .header("X-Title", "PR Review")
        .body(request)
        .send()
        .await
        .map_err(|error| error.without_url().to_string())?;
    let status = response.status();
    let text = response.text().await.map_err(|error| error.without_url().to_string())?;
    if status.is_success() {
        return Ok(text);
    }
    Err(format!("Jev {status}: {}", text.chars().take(300).collect::<String>()))
}

/// Asks an OpenRouter chat model for a file grouping. The frontend builds the full request body (model, messages,
/// structured-output schema); this only checks its size and adds the key, which never leaves the backend.
#[tauri::command]
async fn group_files(request: String) -> Result<String, String> {
    if request.len() > MAX_GROUPING_REQUEST_BYTES {
        return Err("grouping request too large".to_string());
    }
    let key = tauri::async_runtime::spawn_blocking(openrouter_key)
        .await
        .map_err(|error| error.to_string())?
        .ok_or("OPENROUTER_API_KEY not configured")?;
    let response = grouping_client()
        .post(CHAT_URL)
        .bearer_auth(key)
        .header("Content-Type", "application/json")
        .header("X-Title", "PR Review")
        .body(request)
        .send()
        .await
        .map_err(|error| error.without_url().to_string())?;
    let status = response.status();
    let text = response.text().await.map_err(|error| error.without_url().to_string())?;
    if status.is_success() {
        return Ok(text);
    }
    Err(format!("OpenRouter {status}: {}", text.chars().take(300).collect::<String>()))
}

/// Grouping reads a whole diff, so it gets a longer timeout than the 30 s readiness client.
fn grouping_client() -> &'static reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(|| reqwest::Client::builder().timeout(std::time::Duration::from_secs(90)).build().expect("http client"))
}

fn http_client() -> &'static reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(30))
            .build()
            .expect("http client")
    })
}

#[tauri::command]
async fn open_in_browser(url: String) -> Result<(), String> {
    let is_safe = url.starts_with("https://")
        && url.len() <= 4_096
        && !url.chars().any(|character| character.is_whitespace() || character.is_control());
    if !is_safe {
        return Err("only https links can be opened".to_string());
    }
    // The default browser, so link routers like Ferry or Velja can pick the browser and profile.
    let status = Command::new("/usr/bin/open").args(["--", &url]).status().await.map_err(|error| error.to_string())?;
    if status.success() { Ok(()) } else { Err(format!("could not open {url}")) }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .invoke_handler(tauri::generate_handler![queue, pull, stack_neighbors, viewer, comment, message_devin, threads, dequeue, set_thread_resolved, reply_to_thread, merge_queue, merge_states, conversation, body, diff, approve, merge, close, open_in_browser, review_context, readiness_available, readiness, group_files])
        .run(tauri::generate_context!())
        .expect("error while running PR Review");
}


#[cfg(test)]
mod tests {
    use super::{classify_graphql_error, extract_devin_org_id, graphql_errors_only, parse_devin_credentials, DevinCredentials, GithubError};

    /// Talks to the real GitHub API with gh's token: `cargo test -- --ignored live_github --nocapture`.
    #[tokio::test]
    #[ignore]
    async fn live_github_queue_and_pull_loads() {
        use super::{body, conversation, diff, queue, viewer, QueueKind};
        let started = std::time::Instant::now();
        let login = viewer().await.expect("viewer");
        println!("viewer {login} in {} ms", started.elapsed().as_millis());
        for kind in [QueueKind::Mine, QueueKind::Review, QueueKind::Involved] {
            let started = std::time::Instant::now();
            let raw = queue(kind).await.expect("queue");
            let pages: serde_json::Value = serde_json::from_str(&raw).unwrap();
            let nodes = pages[0]["data"]["search"]["nodes"].as_array().unwrap();
            let with_detail = nodes.iter().filter(|node| node["reviewDecision"] != serde_json::Value::Null || node["commits"].is_object()).count();
            let missing_checks = nodes.iter().filter(|node| !node["commits"].is_object()).count();
            println!("queue {:?}: {} PRs, {} with details, {} missing details, {} ms", kind as u8, nodes.len(), with_detail, missing_checks, started.elapsed().as_millis());
            println!("  queue payload {} KB", raw.len() / 1024);
            assert_eq!(missing_checks, 0, "every PR gets its detail fields");
            if let Some(first) = nodes.first() {
                let repo = first["repository"]["nameWithOwner"].as_str().unwrap().to_string();
                let number = first["number"].as_u64().unwrap();
                let started = std::time::Instant::now();
                let (b, d, c) = tokio::join!(body(repo.clone(), number), diff(repo.clone(), number), conversation(repo.clone(), number));
                println!("  {repo}#{number}: body {} B, diff {} B, conversation ok={} in {} ms (parallel)", b.expect("body").len(), d.expect("diff").len(), c.is_ok(), started.elapsed().as_millis());
            }
        }
    }

    #[test]
    fn graphql_errors_fail_only_when_there_is_no_data() {
        assert_eq!(graphql_errors_only(r#"{"data":null,"errors":[{"message":"Something went wrong"}]}"#), Some("Something went wrong".to_string()));
        assert_eq!(graphql_errors_only(r#"{"data":{"nodes":[null]},"errors":[{"message":"Could not resolve to a node"}]}"#), None);
        assert_eq!(graphql_errors_only(r#"{"data":{"viewer":{"login":"a"}}}"#), None);
        assert!(matches!(classify_graphql_error("Something went wrong while executing your query".to_string()), GithubError::Retryable(_)));
        assert!(matches!(classify_graphql_error("Could not resolve to a Repository".to_string()), GithubError::Fatal(_)));
    }

    #[test]
    fn parses_devin_credentials_and_org_id() {
        let toml = "windsurf_api_key = \"sk-test-123\"\ndevin_api_url = \"https://api.devinenterprise.com/\"\n";
        assert_eq!(
            parse_devin_credentials(toml),
            Some(DevinCredentials {
                api_key: "sk-test-123".to_string(),
                api_url: "https://api.devinenterprise.com".to_string(),
            })
        );
        assert_eq!(
            parse_devin_credentials("windsurf_api_key = \"sk-only\"\n"),
            Some(DevinCredentials {
                api_key: "sk-only".to_string(),
                api_url: "https://api.devin.ai".to_string(),
            })
        );
        assert_eq!(parse_devin_credentials("devin_api_url = \"https://api.devin.ai\"\n"), None);
        assert_eq!(
            extract_devin_org_id(&serde_json::json!({ "org_id": "org_1", "devin_sessions_org_id": "clerk-org_2" })),
            Some("clerk-org_2".to_string())
        );
        assert_eq!(extract_devin_org_id(&serde_json::json!({ "org_id": "../bad" })), None);
    }
}
