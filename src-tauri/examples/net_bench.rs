use pr_review_lib::bench_api::{self, CheckTarget, QueueKind};
use serde::Serialize;
use std::time::Instant;

#[derive(Serialize)]
struct ScenarioReport {
    name: String,
    #[serde(rename = "wallMs")]
    wall_ms: f64,
    ok: bool,
    error: Option<String>,
    work: serde_json::Value,
}

async fn control(client: &reqwest::Client, base: &str, path: &str) -> Result<(), String> {
    let response = client
        .post(format!("{base}{path}"))
        .send()
        .await
        .map_err(|error| error.to_string())?;
    if !response.status().is_success() {
        return Err(format!("control {path} returned {}", response.status()));
    }
    Ok(())
}

fn verify_queue(raw: &str, expected_count: usize) -> Result<(Vec<serde_json::Value>, serde_json::Value), String> {
    let pages: serde_json::Value = serde_json::from_str(raw).map_err(|error| format!("bad queue json: {error}"))?;
    let nodes = pages[0]["data"]["search"]["nodes"]
        .as_array()
        .cloned()
        .ok_or_else(|| "queue response missing nodes array".to_string())?;
    if nodes.len() != expected_count {
        return Err(format!("expected {expected_count} PRs, got {}", nodes.len()));
    }
    let missing_details = nodes
        .iter()
        .filter(|node| !node["commits"].is_object() || !node["additions"].is_number())
        .count();
    if missing_details > 0 {
        return Err(format!("{missing_details} PRs missing commits/additions detail fields"));
    }
    Ok((
        nodes,
        serde_json::json!({ "prs": expected_count, "bytes": raw.len(), "missingDetails": missing_details }),
    ))
}

fn main() {
    let api_base = std::env::var("PR_REVIEW_GITHUB_API").expect("PR_REVIEW_GITHUB_API must be set to loopback mock URL");
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .expect("tokio runtime");

    let reports = runtime.block_on(async move {
        let ctrl = reqwest::Client::new();
        let mut reports: Vec<ScenarioReport> = Vec::new();
        let mut involved_nodes: Vec<serde_json::Value> = Vec::new();

        // 1. queue-cold-300
        let _ = control(&ctrl, &api_base, "/__bench/stage/queue-cold-300").await;
        let started = Instant::now();
        let cold_res = bench_api::queue(QueueKind::Involved).await.and_then(|raw| verify_queue(&raw, 300));
        let wall_ms = started.elapsed().as_secs_f64() * 1_000.0;
        match cold_res {
            Ok((nodes, work)) => {
                involved_nodes = nodes;
                reports.push(ScenarioReport { name: "queue-cold-300".into(), wall_ms, ok: true, error: None, work });
            }
            Err(error) => {
                reports.push(ScenarioReport { name: "queue-cold-300".into(), wall_ms, ok: false, error: Some(error), work: serde_json::json!({}) });
            }
        }

        // 2. queue-warm-300 (5% of PRs bumped updatedAt, 95% unchanged)
        let _ = control(&ctrl, &api_base, "/__bench/mutate-warm").await;
        let _ = control(&ctrl, &api_base, "/__bench/stage/queue-warm-300").await;
        let started = Instant::now();
        let warm_res = bench_api::queue(QueueKind::Involved).await.and_then(|raw| verify_queue(&raw, 300));
        let wall_ms = started.elapsed().as_secs_f64() * 1_000.0;
        match warm_res {
            Ok((_, work)) => reports.push(ScenarioReport { name: "queue-warm-300".into(), wall_ms, ok: true, error: None, work }),
            Err(error) => reports.push(ScenarioReport { name: "queue-warm-300".into(), wall_ms, ok: false, error: Some(error), work: serde_json::json!({}) }),
        }

        // 3. queue-small-20 (<= 100 PRs, Review tab)
        let _ = control(&ctrl, &api_base, "/__bench/stage/queue-small-20").await;
        let started = Instant::now();
        let small_res = bench_api::queue(QueueKind::Review).await.and_then(|raw| verify_queue(&raw, 20));
        let wall_ms = started.elapsed().as_secs_f64() * 1_000.0;
        match small_res {
            Ok((_, work)) => reports.push(ScenarioReport { name: "queue-small-20".into(), wall_ms, ok: true, error: None, work }),
            Err(error) => reports.push(ScenarioReport { name: "queue-small-20".into(), wall_ms, ok: false, error: Some(error), work: serde_json::json!({}) }),
        }

        // 4. open-pr (parallel pull_details + diff)
        let _ = control(&ctrl, &api_base, "/__bench/stage/open-pr").await;
        let started = Instant::now();
        let details_task = tokio::spawn(bench_api::pull_details("o/web".to_string(), 1001));
        let diff_task = tokio::spawn(bench_api::diff("o/web".to_string(), 1001));
        let details_res = details_task.await.map_err(|error| error.to_string()).and_then(|inner| inner);
        let diff_res = diff_task.await.map_err(|error| error.to_string()).and_then(|inner| inner);
        let wall_ms = started.elapsed().as_secs_f64() * 1_000.0;
        let mut first_diff = String::new();
        match (details_res, diff_res) {
            (Ok(details_raw), Ok(patch)) => {
                let parsed: serde_json::Value = serde_json::from_str(&details_raw).unwrap_or_default();
                let pr = &parsed["data"]["repository"]["pullRequest"];
                let has_body = pr["bodyHTML"].as_str().is_some_and(|text| !text.is_empty());
                let comments = pr["comments"]["nodes"].as_array().map_or(0, Vec::len);
                let threads = pr["reviewThreads"]["nodes"].as_array().map_or(0, Vec::len);
                let ok = has_body && comments > 0 && threads > 0 && patch.contains("diff --git");
                let error = (!ok).then(|| format!("incomplete open-pr: has_body={has_body} comments={comments} threads={threads} diff_len={}", patch.len()));
                first_diff = patch.clone();
                reports.push(ScenarioReport {
                    name: "open-pr".into(),
                    wall_ms,
                    ok,
                    error,
                    work: serde_json::json!({ "detailsBytes": details_raw.len(), "diffBytes": patch.len(), "comments": comments, "threads": threads }),
                });
            }
            (Err(error), _) | (_, Err(error)) => {
                reports.push(ScenarioReport { name: "open-pr".into(), wall_ms, ok: false, error: Some(error), work: serde_json::json!({}) });
            }
        }

        // 5. reopen-pr-etag (same diff fetched again; should hit 304 Not Modified via ETag)
        let _ = control(&ctrl, &api_base, "/__bench/stage/reopen-pr-etag").await;
        let started = Instant::now();
        let reopen_res = bench_api::diff("o/web".to_string(), 1001).await;
        let wall_ms = started.elapsed().as_secs_f64() * 1_000.0;
        match reopen_res {
            Ok(patch) => {
                let ok = !first_diff.is_empty() && patch == first_diff;
                let error = (!ok).then(|| format!("etag diff mismatch: {} vs {}", patch.len(), first_diff.len()));
                reports.push(ScenarioReport { name: "reopen-pr-etag".into(), wall_ms, ok, error, work: serde_json::json!({ "diffBytes": patch.len() }) });
            }
            Err(error) => {
                reports.push(ScenarioReport { name: "reopen-pr-etag".into(), wall_ms, ok: false, error: Some(error), work: serde_json::json!({}) });
            }
        }

        // 6. huge-pr-diff (406 too_large -> 8-page parallel /files fallback)
        let _ = control(&ctrl, &api_base, "/__bench/stage/huge-pr-diff").await;
        let started = Instant::now();
        let huge_res = bench_api::diff("o/web".to_string(), 9999).await;
        let wall_ms = started.elapsed().as_secs_f64() * 1_000.0;
        match huge_res {
            Ok(patch) => {
                let file_count = patch.matches("diff --git ").count();
                let ordered = patch.find("src/file-000.ts") < patch.find("src/file-749.ts");
                let ok = file_count == 750 && ordered;
                let error = (!ok).then(|| format!("expected 750 ordered files, got {file_count} (ordered={ordered})"));
                reports.push(ScenarioReport {
                    name: "huge-pr-diff".into(),
                    wall_ms,
                    ok,
                    error,
                    work: serde_json::json!({ "files": file_count, "diffBytes": patch.len() }),
                });
            }
            Err(error) => {
                reports.push(ScenarioReport { name: "huge-pr-diff".into(), wall_ms, ok: false, error: Some(error), work: serde_json::json!({}) });
            }
        }

        // 7. merge-states-300 (merge_states for 300 PRs + failing_checks for non-SUCCESS PRs)
        let _ = control(&ctrl, &api_base, "/__bench/stage/merge-states-300").await;
        let started = Instant::now();
        let ids: Vec<String> = involved_nodes.iter().filter_map(|node| node["id"].as_str().map(str::to_string)).collect();
        let targets: Vec<CheckTarget> = involved_nodes
            .iter()
            .filter(|node| {
                let state = node["commits"]["nodes"][0]["commit"]["statusCheckRollup"]["state"].as_str();
                state.is_some() && state != Some("SUCCESS")
            })
            .filter_map(|node| {
                Some(CheckTarget {
                    id: node["id"].as_str()?.to_string(),
                    repo: node["repository"]["nameWithOwner"].as_str()?.to_string(),
                    base: node["stack"]["baseRefName"].as_str().or_else(|| node["baseRefName"].as_str())?.to_string(),
                })
            })
            .collect();
        let expected_targets = targets.len();
        let mut jobs = tokio::task::JoinSet::new();
        for chunk in ids.chunks(12) {
            let batch = chunk.to_vec();
            jobs.spawn(async move {
                let raw = bench_api::merge_states(batch).await?;
                let parsed: serde_json::Value = serde_json::from_str(&raw).map_err(|error| error.to_string())?;
                Ok::<(bool, usize), String>((true, parsed["data"]["nodes"].as_array().map_or(0, Vec::len)))
            });
        }
        for chunk in targets.chunks(25) {
            let batch = chunk.to_vec();
            jobs.spawn(async move {
                let raw = bench_api::failing_checks(batch).await?;
                let parsed: serde_json::Value = serde_json::from_str(&raw).map_err(|error| error.to_string())?;
                Ok::<(bool, usize), String>((false, parsed["data"].as_array().map_or(0, Vec::len)))
            });
        }
        let mut core_count = 0usize;
        let mut check_count = 0usize;
        let mut batch_errors: Vec<String> = Vec::new();
        while let Some(joined) = jobs.join_next().await {
            match joined {
                Ok(Ok((true, count))) => core_count += count,
                Ok(Ok((false, count))) => check_count += count,
                Ok(Err(error)) => batch_errors.push(error),
                Err(error) => batch_errors.push(error.to_string()),
            }
        }
        let wall_ms = started.elapsed().as_secs_f64() * 1_000.0;
        let ok = batch_errors.is_empty() && core_count == ids.len() && check_count == expected_targets;
        let error = (!ok).then(|| {
            if !batch_errors.is_empty() {
                batch_errors[0].clone()
            } else {
                format!("merge-states mismatch: core={core_count}/{} checks={check_count}/{expected_targets}", ids.len())
            }
        });
        reports.push(ScenarioReport {
            name: "merge-states-300".into(),
            wall_ms,
            ok,
            error,
            work: serde_json::json!({ "core": core_count, "checkTargets": check_count }),
        });

        let _ = control(&ctrl, &api_base, "/__bench/stage/done").await;
        reports
    });

    println!("{}", serde_json::to_string(&reports).expect("serialize report"));
}
