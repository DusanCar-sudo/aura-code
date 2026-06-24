// ─────────────────────────────────────────────────────────────────────────────
// LearnLight Lesson Preparation Types
// ─────────────────────────────────────────────────────────────────────────────

/** CEFR language proficiency levels. */
export type ProficiencyLevel =
  | 'A1' | 'A2'    // Beginner
  | 'B1' | 'B2'    // Intermediate
  | 'C1' | 'C2';   // Advanced

/** Age group for the learner. */
export type AgeGroup = 'child' | 'teen' | 'adult' | 'senior';

/** Lesson focus / skill area. */
export type SkillArea =
  | 'speaking'
  | 'listening'
  | 'reading'
  | 'writing'
  | 'grammar'
  | 'vocabulary'
  | 'pronunciation'
  | 'business'
  | 'exam-preparation'
  | 'conversation';

/** A single vocabulary item for the lesson. */
export interface VocabularyItem {
  word: string;
  partOfSpeech: string;
  definition: string;
  exampleSentence: string;
  /** Optional IPA pronunciation guide. */
  ipa?: string;
}

/** A single exercise or activity within the lesson. */
export interface LessonActivity {
  name: string;
  durationMinutes: number;
  skillArea: SkillArea;
  description: string;
  instructions: string;
  materials: string[];
  interactionType: 'teacher-led' | 'pair-work' | 'group-work' | 'individual' | 'whole-class';
}

/** Student profile summary for the lesson. */
export interface StudentProfile {
  name: string;
  level: ProficiencyLevel;
  ageGroup: AgeGroup;
  nativeLanguage: string;
  /** Primary goals the student wants to achieve. */
  goals: string[];
  /** Areas the student struggles with. */
  weaknesses: string[];
  /** Topics the student enjoys. */
  interests: string[];
  /** Optional notes from previous lessons. */
  previousNotes?: string;
}

/** The full lesson plan produced by the workflow. */
export interface LessonPlan {
  /** Lesson title / topic. */
  title: string;
  /** CEFR level this lesson targets. */
  level: ProficiencyLevel;
  /** Duration of the full lesson in minutes. */
  totalDurationMinutes: number;
  /** Smart learning objectives (Specific, Measurable, Achievable, Relevant, Time-bound). */
  objectives: string[];
  /** Ordered list of activities. */
  activities: LessonActivity[];
  /** Key vocabulary for this lesson. */
  vocabulary: VocabularyItem[];
  /** Materials needed (PDFs, links, worksheets, etc.). */
  materials: string[];
  /** Homework assignments. */
  homework?: string[];
  /** Teacher notes / delivery tips. */
  teacherNotes: string[];
}

/** Input parameters for generating a lesson. */
export interface LessonPrepInput {
  topic: string;
  student: StudentProfile;
  /** Desired duration in minutes (default: 50). */
  durationMinutes?: number;
  /** Specific skill areas to focus on. */
  focusAreas?: SkillArea[];
  /** Any additional instructions or constraints. */
  notes?: string;
}
