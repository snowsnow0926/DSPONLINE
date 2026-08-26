use anyhow::{Context, bail};

use crate::{CoreAdvanceRequest, CoreState, CoreStateSummary, SimulationCommandPatch};

impl CoreState {
    /// Replays one accepted JavaScript authority operation transactionally.
    /// A command and a simulation advance are two distinct revision changes,
    /// exactly as they are in `simulation.worker.ts`. Any unsupported domain or
    /// final-revision mismatch leaves the original native state untouched.
    pub fn replay_operation(
        &mut self,
        base_revision: u64,
        result_revision: u64,
        command: Option<&SimulationCommandPatch>,
        simulation_seconds: f64,
        wall_seconds: f64,
    ) -> anyhow::Result<CoreStateSummary> {
        if self.revision != base_revision || result_revision <= base_revision {
            bail!("native core replay revision range is invalid");
        }
        let mut next = self.clone();
        if let Some(command) = command {
            if command.base_revision != base_revision {
                bail!("native core replay command base revision is invalid");
            }
            next.apply_command(command)
                .context("apply native core replay command")?;
        }
        let advanced = next
            .advance(&CoreAdvanceRequest {
                base_revision: next.revision,
                simulation_seconds,
                wall_seconds,
            })
            .context("advance native core replay operation")?;
        if !advanced.supported {
            bail!(
                "native core replay reached unsupported domain: {}",
                advanced.reason.as_deref().unwrap_or("unknown")
            );
        }
        if next.revision != result_revision {
            bail!("native core replay result revision is invalid");
        }
        let summary = next.summary()?;
        *self = next;
        Ok(summary)
    }
}
