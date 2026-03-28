use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct WorkflowRef {
    #[serde(rename = "workflowId")]
    pub workflow_id: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Action {
    #[serde(rename = "type")]
    pub action_type: String,
    pub content: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub agent: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub shell: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct WorkflowState {
    pub id: String,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub subagent: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub actions: Option<Vec<Action>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub subflow: Option<WorkflowRef>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub position: Option<Position>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Position {
    pub x: f64,
    pub y: f64,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Transition {
    pub from: String,
    pub to: String,
    pub description: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Workflow {
    pub id: String,
    pub name: String,
    pub description: String,
    pub states: Vec<WorkflowState>,
    pub transitions: Vec<Transition>,
    #[serde(default = "default_version")]
    pub version: u32,
    #[serde(rename = "createdAt", skip_serializing_if = "Option::is_none")]
    pub created_at: Option<String>,
    #[serde(rename = "updatedAt", skip_serializing_if = "Option::is_none")]
    pub updated_at: Option<String>,
}

fn default_version() -> u32 {
    1
}

#[derive(Debug, Serialize)]
pub struct WorkflowSummary {
    pub id: String,
    pub name: String,
    pub description: String,
    #[serde(rename = "updatedAt")]
    pub updated_at: Option<String>,
}

fn workflows_dir() -> Option<PathBuf> {
    dirs::home_dir().map(|h| h.join(".agent-flow").join("workflows"))
}

fn sanitize_id(id: &str) -> Result<&str, String> {
    if id.is_empty() {
        return Err("Workflow ID cannot be empty".to_string());
    }
    if id.chars().all(|c| c.is_alphanumeric() || c == '-' || c == '_') {
        Ok(id)
    } else {
        Err(format!("Invalid workflow ID: {}", id))
    }
}

fn ensure_dir() -> Result<PathBuf, String> {
    let dir = workflows_dir().ok_or("Could not determine home directory")?;
    fs::create_dir_all(&dir).map_err(|e| format!("Failed to create workflows dir: {}", e))?;
    Ok(dir)
}

#[tauri::command]
pub fn save_workflow(workflow: Workflow) -> Result<(), String> {
    sanitize_id(&workflow.id)?;
    let dir = ensure_dir()?;
    let mut workflow = workflow;

    let now = chrono::Utc::now().to_rfc3339();
    if workflow.created_at.is_none() {
        workflow.created_at = Some(now.clone());
    }
    workflow.updated_at = Some(now);

    let path = dir.join(format!("{}.json", workflow.id));
    let tmp_path = dir.join(format!(".{}.tmp", workflow.id));

    let json =
        serde_json::to_string_pretty(&workflow).map_err(|e| format!("Serialize error: {}", e))?;

    // Atomic write: write to temp, then rename
    fs::write(&tmp_path, &json).map_err(|e| format!("Write error: {}", e))?;
    fs::rename(&tmp_path, &path).map_err(|e| format!("Rename error: {}", e))?;

    Ok(())
}

#[tauri::command]
pub fn load_workflow(id: String) -> Result<Workflow, String> {
    sanitize_id(&id)?;
    let dir = workflows_dir().ok_or("Could not determine home directory")?;
    let path = dir.join(format!("{}.json", id));

    let text = fs::read_to_string(&path).map_err(|e| format!("Read error: {}", e))?;
    let workflow: Workflow =
        serde_json::from_str(&text).map_err(|e| format!("Parse error: {}", e))?;

    Ok(workflow)
}

#[tauri::command]
pub fn list_workflows() -> Result<Vec<WorkflowSummary>, String> {
    let dir = match workflows_dir() {
        Some(d) if d.exists() => d,
        _ => return Ok(Vec::new()),
    };

    let mut summaries = Vec::new();

    let entries = fs::read_dir(&dir).map_err(|e| format!("Read dir error: {}", e))?;

    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().is_some_and(|e| e == "json") {
            if let Ok(text) = fs::read_to_string(&path) {
                if let Ok(w) = serde_json::from_str::<Workflow>(&text) {
                    summaries.push(WorkflowSummary {
                        id: w.id,
                        name: w.name,
                        description: w.description,
                        updated_at: w.updated_at,
                    });
                }
            }
        }
    }

    summaries.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
    Ok(summaries)
}

#[tauri::command]
pub fn delete_workflow(id: String) -> Result<(), String> {
    sanitize_id(&id)?;
    let dir = workflows_dir().ok_or("Could not determine home directory")?;
    let path = dir.join(format!("{}.json", id));

    if path.exists() {
        fs::remove_file(&path).map_err(|e| format!("Delete error: {}", e))?;
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_workflow() -> Workflow {
        Workflow {
            id: "test-wf".to_string(),
            name: "Test Workflow".to_string(),
            description: "A test".to_string(),
            states: vec![WorkflowState {
                id: "s1".to_string(),
                name: "State 1".to_string(),
                subagent: None,
                actions: Some(vec![Action {
                    action_type: "prompt".to_string(),
                    content: "Do something".to_string(),
                    agent: None,
                    model: None,
                    shell: None,
                }]),
                subflow: None,
                position: None,
            }],
            transitions: vec![],
            version: 1,
            created_at: None,
            updated_at: None,
        }
    }

    #[test]
    fn test_roundtrip() {
        let tmp = std::env::temp_dir().join("agent-flow-test-wf");
        let _ = fs::remove_dir_all(&tmp);
        fs::create_dir_all(&tmp).unwrap();

        let wf = test_workflow();
        let path = tmp.join(format!("{}.json", wf.id));

        let json = serde_json::to_string_pretty(&wf).unwrap();
        fs::write(&path, &json).unwrap();

        let text = fs::read_to_string(&path).unwrap();
        let loaded: Workflow = serde_json::from_str(&text).unwrap();

        assert_eq!(loaded.id, "test-wf");
        assert_eq!(loaded.name, "Test Workflow");
        assert_eq!(loaded.states.len(), 1);
        assert_eq!(loaded.states[0].actions.as_ref().unwrap()[0].content, "Do something");

        let _ = fs::remove_dir_all(&tmp);
    }

    #[test]
    fn test_action_model_field_roundtrip() {
        let action = Action {
            action_type: "prompt".to_string(),
            content: "analyze code".to_string(),
            agent: Some("Explore".to_string()),
            model: Some("opus".to_string()),
            shell: None,
        };

        let json = serde_json::to_string(&action).unwrap();
        assert!(json.contains(r#""model":"opus"#));

        let parsed: Action = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed.model, Some("opus".to_string()));
        assert_eq!(parsed.agent, Some("Explore".to_string()));
    }

    #[test]
    fn test_action_model_field_omitted_when_none() {
        let action = Action {
            action_type: "prompt".to_string(),
            content: "do something".to_string(),
            agent: None,
            model: None,
            shell: None,
        };

        let json = serde_json::to_string(&action).unwrap();
        assert!(!json.contains("model"));
    }
}
