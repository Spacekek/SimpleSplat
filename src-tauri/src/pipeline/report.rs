//! Progress events, with the job's overall progress and time left.

use super::STAGES;
use serde::Serialize;
use std::path::PathBuf;
use std::time::{Duration, Instant};

/// Progress reported while the pipeline runs. `stage` counts from 0.
#[derive(Clone, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Event {
    Project {
        path: PathBuf,
    },
    StageStart {
        stage: usize,
        name: String,
        skipped: bool,
    },
    StageDone {
        stage: usize,
        secs: u64,
    },
    Info {
        text: String,
    },
    /// `fraction` of the stage is done and `overall` of the job; `eta` is seconds left.
    Progress {
        stage: usize,
        fraction: f64,
        overall: f64,
        eta: u64,
        what: String,
    },
    Preview {
        path: PathBuf,
    },
}

/// Sends events, and turns each stage's fraction done into overall progress and time left.
///
/// Each stage has an estimate in seconds from runs on an Apple M5. The speed seen so far scales what
/// is left: the running stage's own once it is 5% along, before that the finished stages' (when they
/// took long enough to tell), else the estimates stand as they are.
pub(super) struct Report<'a> {
    emit: &'a mut dyn FnMut(Event),
    /// Each stage's estimate in seconds; a skipped stage's becomes 0.
    planned: [f64; STAGES],
    stage: usize,
    started: Instant,
    /// Seconds the finished stages took, and what they were estimated to take.
    took: f64,
    estimated: f64,
    sent: Option<Instant>,
}

impl<'a> Report<'a> {
    pub(super) fn new(emit: &'a mut dyn FnMut(Event), estimates: [f64; STAGES]) -> Self {
        Self {
            emit,
            planned: estimates,
            stage: 0,
            started: Instant::now(),
            took: 0.0,
            estimated: 0.0,
            sent: None,
        }
    }

    pub(super) fn event(&mut self, event: Event) {
        (self.emit)(event);
    }

    pub(super) fn start(&mut self, stage: usize, name: &str, skipped: bool) {
        (self.stage, self.started, self.sent) = (stage, Instant::now(), None);
        if skipped {
            self.planned[stage] = 0.0;
        }
        self.event(Event::StageStart {
            stage,
            name: name.into(),
            skipped,
        });
        if !skipped {
            self.progress(0.0, "");
        }
    }

    pub(super) fn done(&mut self) {
        let secs = self.started.elapsed().as_secs_f64();
        self.took += secs;
        self.estimated += self.planned[self.stage];
        self.event(Event::StageDone {
            stage: self.stage,
            secs: secs as u64,
        });
    }

    /// `fraction` of the running stage is done, and it is busy with `what`.
    pub(super) fn progress(&mut self, fraction: f64, what: &str) {
        if self
            .sent
            .is_some_and(|t| t.elapsed() < Duration::from_millis(250))
        {
            return;
        }
        self.sent = Some(Instant::now());
        let fraction = fraction.clamp(0.0, 1.0);
        let total: f64 = self.planned.iter().sum();
        let here = self.planned[self.stage] * fraction;
        let done = self.planned[..self.stage].iter().sum::<f64>() + here;
        let speed = if here > 0.05 * self.planned[self.stage] {
            self.started.elapsed().as_secs_f64() / here
        } else if self.estimated > 30.0 {
            self.took / self.estimated
        } else {
            1.0
        };
        let event = Event::Progress {
            stage: self.stage,
            fraction,
            overall: if total > 0.0 { done / total } else { 1.0 },
            eta: ((total - done) * speed).round() as u64,
            what: what.into(),
        };
        self.event(event);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn time_left_scales_with_the_speed_seen() {
        let mut sent = Vec::new();
        let mut emit = |event| sent.push(event);
        let mut out = Report::new(&mut emit, [10.0, 100.0, 890.0]);
        out.start(0, "frames", true);
        out.start(1, "sfm", false);
        out.started -= Duration::from_secs(20); // twice as slow as estimated
        out.sent = None;
        out.progress(0.1, "");
        let Some(Event::Progress { overall, eta, .. }) = sent.last() else {
            panic!("no progress sent");
        };
        // Skipped frames count for nothing: 10 of 990 estimated seconds done, 980 left at half speed.
        assert!((overall - 10.0 / 990.0).abs() < 1e-9);
        assert_eq!(*eta, 1960);
    }
}
