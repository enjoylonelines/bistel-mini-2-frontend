"use client";

import { useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import ReactMarkdown from "react-markdown";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";
import chatApi, { normalizeAssistantMessage } from "@/apis/chatApi";
import { sendMessageStream } from "@/apis/chatStreamClient";
import eligibilityApi from "@/apis/eligibilityApi";
import { createRecommendationRequest, getRecommendationResult, submitRecommendationAnswers } from "@/apis/recommendationApi";
import { getApiErrorMessage } from "@/apis/axiosConfig";
import PolicySummaryCard from "@/app/components/PolicySummaryCard";
import CompareChatCard from "@/app/components/CompareChatCard";
import EvidencesChat from "@/app/components/EvidencesChat";
import EligibilityCardChat from "@/app/components/EligibilityCardChat";
import Header from "@/app/components/Header";
import Icon from "@/app/components/Icon";
import NextActions from "@/app/components/NextActions";
import PolicyCardChat from "@/app/components/PolicyCardChat";
import SimilarPolicies from "@/app/components/SimilarPolicies";
import RecommendChatCard from "@/app/components/RecommendChatCard";
import ChatPromptDock from "@/app/components/ChatPromptDock";
import { DISCLAIMER_TEXT } from "@/app/data/constants";
import { AuthContext } from "@/contexts/AuthContext";
import {
  applyProgressEvent,
  createChatProgress,
  setProgressFlow,
  tickChatProgress,
} from "@/app/chat/chatProgress.mjs";

const EXAMPLE_CHIPS = [
  "임신 중인데 받을 수 있는 지원 알려줘",
  "부모급여랑 아동수당 뭐가 달라?",
  "첫만남이용권 신청 준비물",
  "어린이집 다녀도 아이돌봄 되나요?",
];

const QUICK_ACTIONS = [
  {
    key: "recommend",
    title: "맞춤 정책 추천",
    description: "내 상황을 입력하면 받을 만한 지원을 찾아드려요",
    icon: "Target",
    prompt: "맞춤 정책 추천을 받고 싶어요.",
    tone: "coral",
  },
  {
    key: "eligibility",
    title: "지원 가능성 확인",
    description: "이 정책, 우리 가족도 받을 수 있을까요?",
    icon: "ShieldCheck",
    prompt: "내 상황에서 받을 수 있는지 지원 가능성을 확인하고 싶어요.",
    tone: "blue",
  },
  {
    key: "compare",
    title: "정책 비교",
    description: "비슷한 두 정책, 뭐가 더 맞을까요?",
    icon: "GitCompare",
    prompt: "아동수당과 부모급여 두 정책 비교해줘.",
    tone: "amber",
  },
  {
    key: "summary",
    title: "정책 요약",
    description: "정책 핵심만 쉽게 요약해 드려요",
    icon: "FileText",
    prompt: "정책을 핵심 위주로 쉽게 요약해줘.",
    tone: "green",
  },
];

const CONDITION_GROUPS = [
  { key: "stage", label: "생애단계", options: ["임신", "출산", "영유아", "초등"] },
  { key: "childAge", label: "자녀 나이", options: ["0세", "1세", "2~3세", "4~6세", "초등"] },
  { key: "income", label: "소득", options: ["전체", "중위 80% 이하", "중위 100% 이하", "모름"] },
  { key: "region", label: "지역", options: ["서울", "경기", "인천", "부산", "대구"] },
];

const SPECIAL_OPTIONS = ["한부모", "다자녀", "맞벌이", "장애", "다문화"];

const makeId = (prefix) => `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
const getErrorMessage = (error) => error?.message || "메시지를 보내지 못했어요. 잠시 후 다시 시도해주세요.";
const ACTIVE_CHAT_SESSION_STORAGE_KEY = "dodam.activeChatSessionId";
const CHAT_PENDING_REQUESTS_STORAGE_KEY = "dodam.chat.pendingRequests.v1";
const SESSION_RESTORE_TIMEOUT_MS = 8000;
const CHAT_RECOVERY_MAX_WAIT_MS = 45000;
const CHAT_RECOVERY_BASE_DELAY_MS = 1200;
const CHAT_MARKDOWN_REMARK_PLUGINS = [[remarkGfm, { singleTilde: false }], remarkBreaks];

const CHAT_REQUEST_UI_STATUS = {
  SENDING: "sending",
  PROCESSING: "processing",
  COMPLETED: "completed",
  FAILED: "failed",
  RECONNECTING: "reconnecting",
  CANCELLED: "cancelled",
};

const CHAT_PROGRESS_TEXT = {
  accepted: "요청을 확인하고 있어요",
  processing: "요청은 정상적으로 처리 중이에요.",
  reconnecting: "응답을 다시 연결하고 있어요.",
  failed: "응답을 완료하지 못했어요. 다시 시도해 주세요.",
  cancelled: "요청이 취소됐어요.",
  analyzing: "조건을 분석하고 있어요",
  searching: "관련 정책을 찾고 있어요",
  composing: "결과를 정리하고 있어요",
};

const readStoredActiveSessionId = () => {
  if (typeof window === "undefined") return null;
  return window.sessionStorage.getItem(ACTIVE_CHAT_SESSION_STORAGE_KEY);
};

const storeActiveSessionId = (sessionId) => {
  if (typeof window === "undefined") return;
  if (sessionId) {
    window.sessionStorage.setItem(ACTIVE_CHAT_SESSION_STORAGE_KEY, String(sessionId));
  } else {
    window.sessionStorage.removeItem(ACTIVE_CHAT_SESSION_STORAGE_KEY);
  }
};

const readPendingChatRequests = () => {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.sessionStorage.getItem(CHAT_PENDING_REQUESTS_STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : {};
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
};

const writePendingChatRequests = (requests) => {
  if (typeof window === "undefined") return;
  const entries = Object.entries(requests || {}).filter(([, value]) => value?.sessionId);
  if (entries.length === 0) {
    window.sessionStorage.removeItem(CHAT_PENDING_REQUESTS_STORAGE_KEY);
    return;
  }
  window.sessionStorage.setItem(CHAT_PENDING_REQUESTS_STORAGE_KEY, JSON.stringify(Object.fromEntries(entries)));
};

const storePendingChatRequest = (pending) => {
  if (!pending?.sessionId) return;
  const requests = readPendingChatRequests();
  requests[String(pending.sessionId)] = {
    ...requests[String(pending.sessionId)],
    ...pending,
    sessionId: String(pending.sessionId),
    updatedAt: new Date().toISOString(),
  };
  writePendingChatRequests(requests);
};

const clearPendingChatRequest = (sessionId, requestId) => {
  if (!sessionId) return;
  const requests = readPendingChatRequests();
  const current = requests[String(sessionId)];
  if (!current) return;
  if (requestId && current.requestId && String(current.requestId) !== String(requestId)) return;
  delete requests[String(sessionId)];
  writePendingChatRequests(requests);
};

const createIdempotencyKey = () => {
  if (typeof crypto !== "undefined" && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
};

const getChatRequestId = (eventOrPayload) =>
  eventOrPayload?.request_id ||
  eventOrPayload?.requestId ||
  eventOrPayload?.data?.request_id ||
  eventOrPayload?.data?.requestId ||
  null;

const normalizeChatRequestStatusValue = (status) => {
  const value = String(status || "").toLowerCase();
  if (value === "completed") return CHAT_REQUEST_UI_STATUS.COMPLETED;
  if (value === "failed") return CHAT_REQUEST_UI_STATUS.FAILED;
  if (value === "cancelled") return CHAT_REQUEST_UI_STATUS.CANCELLED;
  if (value === "processing") return CHAT_REQUEST_UI_STATUS.PROCESSING;
  return value || CHAT_REQUEST_UI_STATUS.PROCESSING;
};

const getProgressMessage = (event) => {
  const text = `${event?.node || ""} ${event?.flow || ""} ${event?.label || ""}`.toLowerCase();
  if (/condition|profile|slot|분석|조건/.test(text)) return CHAT_PROGRESS_TEXT.analyzing;
  if (/search|candidate|rag|policy|retriev|검색|정책|후보/.test(text)) return CHAT_PROGRESS_TEXT.searching;
  if (/compose|summary|answer|result|respond|정리|결과|요약/.test(text)) return CHAT_PROGRESS_TEXT.composing;
  return CHAT_PROGRESS_TEXT.processing;
};

const mergeAssistantMessage = (messages, assistantMessage, replaceId) => {
  const nextMessageId = String(assistantMessage?.id || "");
  const exists = nextMessageId && messages.some((message) => String(message.id) === nextMessageId);
  if (exists) {
    return messages.filter((message) => message.id !== replaceId);
  }
  const withoutTemporary = messages.filter((message) => message.id !== replaceId);
  return [...withoutTemporary, assistantMessage];
};

const formatSessionTime = (value) => {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat("ko-KR", {
    month: "numeric",
    day: "numeric",
  }).format(date);
};

const getPolicySlug = (policy) =>
  policy?.slug || policy?.policy_slug || policy?.policySlug || policy?.policy_id || policy?.policyId;

const getEligibilityPolicySlug = (eligibility) =>
  eligibility?.result?.slug ||
  eligibility?.result?.policy_slug ||
  eligibility?.result?.policySlug ||
  eligibility?.sourceRefId ||
  eligibility?.source_ref_id ||
  eligibility?.policyId ||
  eligibility?.policy_id;

const getPolicyName = (policy) =>
  policy?.policy_name || policy?.policyName || policy?.name || null;

const getContextPolicy = (messages) => {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message.role !== "assistant") continue;
    if (message.contextPolicy) return message.contextPolicy;
    const policyName = getPolicyName(message.policies?.[0]);
    if (policyName) return policyName;
  }
  return null;
};

const buildRecommendContent = (conditions) => {
  const parts = [
    conditions.stage && `생애단계: ${conditions.stage}`,
    conditions.childAge && `자녀 나이: ${conditions.childAge}`,
    conditions.income && `소득: ${conditions.income}`,
    conditions.region && `지역: ${conditions.region}`,
    conditions.special.length > 0 && `특이사항: ${conditions.special.join(", ")}`,
  ].filter(Boolean);
  return parts.length > 0
    ? `맞춤 추천을 받고 싶어요. ${parts.join(" / ")}`
    : "맞춤 추천을 받고 싶어요.";
};

const hasRecommendIntent = (text) =>
  /추천|맞춤|받을 만|받을 수 있|지원.*찾|지원.*알려|어떤.*지원|무슨.*지원/.test(text);

const SUMMARY_ACTIONS = new Set(["summary", "summary_card", "policy_summary"]);

const getActionKey = (action) =>
  typeof action === "string" ? action : action?.action || action?.type || action?.key;

const hasAction = (actions, key) => actions.some((action) => getActionKey(action) === key);

const hasSummaryAction = (actions) => actions.some((action) => SUMMARY_ACTIONS.has(getActionKey(action)));

const getMessagePolicies = (message) =>
  (message?.policies?.length ? message.policies : message?.recommendations) || [];

const REQUEST_STATUS = {
  READY: "READY",
  PROCESSING: "PROCESSING",
  COMPLETED: "COMPLETED",
  FOLLOW_UP_REQUIRED: "FOLLOW_UP_REQUIRED",
  FAILED: "FAILED",
};

const ELIGIBILITY_POLLING_STATUSES = new Set([
  REQUEST_STATUS.READY,
  REQUEST_STATUS.PROCESSING,
]);

const getPolicyId = (policy) =>
  policy?.policy_id || policy?.policyId || policy?.id || policy?.backend_slug || policy?.backendSlug || policy?.slug;

const getRecommendationSourceRefId = (policy, message) =>
  policy?.recommendation_request_id ||
  policy?.recommendationRequestId ||
  policy?.source_ref_id ||
  policy?.sourceRefId ||
  message?.recommendationRequestId ||
  message?.raw?.recommendation_request_id ||
  message?.raw?.recommendationRequestId;

const getEligibilityRequestId = (response) =>
  response?.request_id ||
  response?.requestId ||
  response?.data?.request_id ||
  response?.data?.requestId ||
  response?.eligibility_request?.request_id ||
  response?.eligibilityRequest?.requestId;

const getMessageEligibilityResult = (message) =>
  message?.eligibilityResult ||
  message?.eligibility_result ||
  message?.raw?.eligibility_result ||
  message?.raw?.eligibilityResult ||
  null;

const getEligibilityQuestions = (result) => {
  if (Array.isArray(result?.follow_up_questions)) return result.follow_up_questions;
  if (Array.isArray(result?.followUpQuestions)) return result.followUpQuestions;
  if (Array.isArray(result?.questions)) return result.questions;
  return [];
};

const ELIGIBILITY_FIELD_LABELS = {
  region: "거주 지역",
  stage: "생애단계 또는 자녀 나이",
  childAge: "자녀 나이",
  child_age: "자녀 나이",
  age: "자녀 나이",
  household_member_age: "자녀 나이",
  income: "가구 소득",
  income_level: "가구 소득",
  income_bracket: "가구 소득",
  median_income_percent: "기준중위소득",
  special: "가구 특성",
};

const isEligibilityClarificationQuestion = (text) =>
  /뭐가\s*부족|무엇이\s*부족|어떤\s*정보|무슨\s*정보|왜\s*부족|부족한.*뭐|필요한.*정보|추가\s*확인|직접\s*확인|뭘\s*확인|무엇을\s*확인|어떤\s*확인/.test(text);

const getEligibilityQuestionText = (question) =>
  question?.question_text ||
  question?.questionText ||
  question?.question ||
  question?.text ||
  question?.prompt ||
  ELIGIBILITY_FIELD_LABELS[question?.field_name || question?.fieldName] ||
  "추가 정보";

const getEligibilityFieldLabel = (question) => {
  const key = question?.field_name || question?.fieldName;
  return ELIGIBILITY_FIELD_LABELS[key] || key || getEligibilityQuestionText(question).replace(/[.。]$/, "");
};

const getEligibilityIssueType = (question) =>
  question?.issue_type || question?.issueType || "";

const getEligibilityIssueReason = (question) => {
  const label = getEligibilityFieldLabel(question);
  const message = question?.message || question?.reason || "";
  const issueType = getEligibilityIssueType(question);

  if (issueType === "ambiguous") {
    return `${label} 값이 여러 개로 해석되어 하나로 확정하지 못했어요.`;
  }
  if (issueType === "invalid") {
    return `${label} 값이 지원하는 선택지와 맞지 않아요.`;
  }
  if (issueType === "missing") {
    return `${label} 정보가 아직 없어요.`;
  }
  if (/ambiguous|multiple/i.test(message)) {
    return `${label} 값이 여러 개로 해석되어 하나로 확정하지 못했어요.`;
  }
  if (/unsupported|invalid/i.test(message)) {
    return `${label} 값이 지원하는 선택지와 맞지 않아요.`;
  }
  if (/missing/i.test(message)) {
    return `${label} 정보가 아직 없어요.`;
  }
  return message || `${label} 확인이 필요해요.`;
};

const buildEligibilityClarificationMessage = (eligibility) => {
  const questions = eligibility?.questions?.length > 0
    ? eligibility.questions
    : getEligibilityQuestions(eligibility?.result);
  const questionReasons = questions.map((question) => getEligibilityIssueReason(question)).filter(Boolean);
  const missing = eligibility?.result?.missing_conditions || eligibility?.result?.missingConditions || [];
  const manual = eligibility?.result?.manual_check_points || eligibility?.result?.manualCheckPoints || [];
  const criteria = [
    ...questionReasons,
    ...missing.map((item) => `${getEligibilityFieldLabel({ field_name: item })} 정보가 더 필요해요.`),
    ...manual.map((item) => `${getEligibilityFieldLabel({ field_name: item })}은 공식 기준이나 실제 상황 확인이 필요해요.`),
  ];

  if (criteria.length === 0) {
    return "현재 분석에 필요한 추가 항목을 확인 중이에요. 선택지가 보이지 않으면 다시 조회하거나 분석을 다시 시작해 주세요.";
  }

  return `현재 추가 확인이 필요한 이유는 ${criteria.join(" ")}입니다. 이 정보가 확인되면 지원 가능성을 더 정확히 판단할 수 있어요.`;
};

const hasEligibilityClarificationContext = (eligibility) => {
  if (!eligibility) return false;
  const questions = eligibility.questions?.length > 0
    ? eligibility.questions
    : getEligibilityQuestions(eligibility.result);
  const missing = eligibility.result?.missing_conditions || eligibility.result?.missingConditions || [];
  const manual = eligibility.result?.manual_check_points || eligibility.result?.manualCheckPoints || [];
  return questions.length > 0 || missing.length > 0 || manual.length > 0;
};

const buildEligibilityQuestionMessage = (eligibility) => {
  const questions = eligibility?.questions?.length > 0
    ? eligibility.questions
    : getEligibilityQuestions(eligibility?.result);
  if (questions.length === 0) return null;

  const lines = questions.map((question) => {
    const text = getEligibilityQuestionText(question);
    const reason = getEligibilityIssueReason(question);
    return reason ? `${text}\n- ${reason}` : text;
  });
  return `추가 확인이 필요해요.\n${lines.join("\n")}`;
};

const buildEligibilityQuestionKey = (eligibility) => {
  const questions = eligibility?.questions?.length > 0
    ? eligibility.questions
    : getEligibilityQuestions(eligibility?.result);
  const questionKey = questions
    .map((question) => [
      question?.field_name || question?.fieldName || "",
      question?.question_text || question?.questionText || "",
      question?.issue_type || question?.issueType || "",
      question?.message || question?.reason || "",
    ].join(":"))
    .join("|");
  return `${eligibility?.requestId || eligibility?.request_id || ""}:${questionKey}`;
};

const getRequestStatusValue = (status) => {
  if (!status) return "";
  if (typeof status === "object") {
    return status.value || status.key || status.status || "";
  }
  return status;
};

const normalizeEligibilityStatus = (status, questions) => {
  const value = String(getRequestStatusValue(status) || "").toUpperCase();
  if (value) return value;
  return questions.length > 0 ? REQUEST_STATUS.FOLLOW_UP_REQUIRED : REQUEST_STATUS.PROCESSING;
};

const buildEligibilityStateFromResult = (eligibilityResult, base = {}) => {
  if (!eligibilityResult) return null;
  const questions = getEligibilityQuestions(eligibilityResult);
  const status = normalizeEligibilityStatus(eligibilityResult.status, questions);
  return {
    ...base,
    requestId: String(eligibilityResult.request_id || eligibilityResult.requestId || base.requestId || ""),
    policyId:
      eligibilityResult.policy_id ||
      eligibilityResult.policyId ||
      base.policyId ||
      "",
    policyName:
      eligibilityResult.policy_name ||
      eligibilityResult.policyName ||
      base.policyName ||
      "",
    sourceType:
      eligibilityResult.source_type ||
      eligibilityResult.sourceType ||
      base.sourceType ||
      "CHAT",
    sourceRefId:
      eligibilityResult.source_ref_id ||
      eligibilityResult.sourceRefId ||
      base.sourceRefId ||
      eligibilityResult.request_id ||
      eligibilityResult.requestId ||
      null,
    userConditions:
      eligibilityResult.user_conditions ||
      eligibilityResult.userConditions ||
      eligibilityResult.input_summary ||
      eligibilityResult.inputSummary ||
      base.userConditions ||
      {},
    status,
    questions: status === REQUEST_STATUS.FOLLOW_UP_REQUIRED ? questions : [],
    criteria:
      eligibilityResult.criteria ||
      eligibilityResult.criteria_results ||
      eligibilityResult.criteriaResults ||
      base.criteria ||
      [],
    result: eligibilityResult,
    error: "",
    loadingMessage: "",
  };
};

const getLatestEligibilityFromMessages = (messages) => {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role !== "assistant") continue;
    const eligibilityResult = getMessageEligibilityResult(message);
    if (eligibilityResult) return buildEligibilityStateFromResult(eligibilityResult);
  }
  return null;
};

const CONDITION_VALUE_MAP = {
  stage: {
    "임신": "pregnant",
    "임신 준비·임신 중": "pregnant",
    "출산": "newborn",
    "출산 직후·신생아": "newborn",
    "영유아": "infant",
    "아동": "child",
    "초등": "child",
    "청소년": "teen",
  },
  childAge: {
    "태아": "preborn",
    "출생 전": "preborn",
    "0세": "0",
    "0세 (12개월 미만)": "0",
    "1세": "1",
    "2~3세": "2-5",
    "2~5세": "2-5",
    "4~6세": "2-5",
    "6~12세": "6-12",
    "초등": "6-12",
    "13세 이상": "13+",
  },
  income: {
    "중위 50% 이하": "low",
    "중위소득 50% 이하": "low",
    "중위 80% 이하": "mid1",
    "중위 100% 이하": "mid1",
    "중위소득 51~100%": "mid1",
    "중위 150% 이하": "mid2",
    "중위소득 101~150%": "mid2",
    "중위소득 150% 초과": "high",
    "전체": "unknown",
    "모름": "unknown",
    "잘 모르겠어요": "unknown",
    "__UNKNOWN__": "unknown",
  },
  region: {
    "서울": "seoul",
    "부산": "busan",
    "대구": "daegu",
    "인천": "incheon",
    "광주": "gwangju",
    "대전": "daejeon",
    "울산": "ulsan",
    "세종": "sejong",
    "경기": "gyeonggi",
    "강원": "gangwon",
    "충북": "chungbuk",
    "충남": "chungnam",
    "전북": "jeonbuk",
    "전남": "jeonnam",
    "경북": "gyeongbuk",
    "경남": "gyeongnam",
    "제주": "jeju",
  },
  special: {
    "한부모": "single",
    "한부모·조손 가정": "single",
    "다문화": "multi",
    "다문화·탈북민 가정": "multi",
    "장애": "disabled",
    "장애인 가구": "disabled",
    "다자녀": "many",
    "다자녀 가정(2명 이상)": "many",
    "맞벌이": "dual",
  },
};

const CONDITION_KEY_MAP = {
  child_age: "childAge",
};

const normalizeConditionValue = (key, value) => {
  if (Array.isArray(value)) {
    return value.map((item) => normalizeConditionValue(key, item)).filter(Boolean);
  }

  const text = String(value || "").trim();
  if (!text || text === "__UNKNOWN__") {
    return key === "income" ? "unknown" : "";
  }

  return CONDITION_VALUE_MAP[key]?.[text] || text;
};

const normalizeRecommendationAnswers = (answers = {}) => {
  const selected = {};

  Object.entries(answers).forEach(([key, value]) => {
    const normalizedKey = CONDITION_KEY_MAP[key] || key;
    const normalizedValue = normalizeConditionValue(normalizedKey, value);
    if (Array.isArray(normalizedValue)) {
      if (normalizedValue.length > 0) selected[normalizedKey] = normalizedValue;
    } else if (normalizedValue) {
      selected[normalizedKey] = normalizedValue;
    }
  });

  return selected;
};

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function EmptyState({ onChip, onQuickAction, showConditions, conditions, onCondition, onSubmitConditions }) {
  return (
    <div className="dd-fade">
      <span className="dd-hero-badge">
        <Icon name="Sparkles" size={12} /> AI 정책 상담
      </span>
      <h1 className="dd-hero-h">어떤 도움이 필요하세요?</h1>
      <p className="dd-hero-p">
        가족 상황이나 궁금한 정책을 편하게 물어보세요. 정책 이름을 몰라도 괜찮아요.
        <br />
        아래에서 시작하면 몇 번의 선택만으로 맞춤 안내를 받을 수 있어요.
      </p>

      <div className="dd-entry-grid">
        {QUICK_ACTIONS.map((item) => (
          <button
            key={item.key}
            type="button"
            className="dd-entry-card"
            onClick={() => onQuickAction(item)}
          >
            <span
              className={`dd-icon-tile dd-tile-${item.tone === "coral" ? "rose" : item.tone}`}
              style={{ width: 42, height: 42 }}
            >
              <Icon name={item.icon} size={20} />
            </span>
            <span style={{ minWidth: 0 }}>
              <span className="dd-entry-t">{item.title}</span>
              <span className="dd-entry-d" style={{ display: "block" }}>{item.description}</span>
            </span>
          </button>
        ))}
      </div>

      {showConditions && (
        <div className="dd-card-soft" style={{ marginTop: 22, padding: 18 }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, flexWrap: "wrap" }}>
            <div>
              <strong style={{ fontSize: 15 }}>추천 조건을 골라주세요</strong>
              <p style={{ margin: "4px 0 0", fontSize: 12, color: "var(--dd-stone-500)" }}>
                선택한 값은 메시지로 전송되고, 백엔드가 추천 조건으로 정규화합니다.
              </p>
            </div>
            <button type="button" className="dd-btn dd-btn-coral dd-btn-sm" onClick={onSubmitConditions}>
              <Icon name="Send" size={14} /> 추천 요청
            </button>
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 12, marginTop: 16 }}>
            {CONDITION_GROUPS.map((group) => (
              <div key={group.key}>
                <div style={{ fontWeight: 700, fontSize: 12, color: "var(--dd-stone-500)", marginBottom: 8 }}>
                  {group.label}
                </div>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                  {group.options.map((option) => (
                    <button
                      key={option}
                      type="button"
                      className={`dd-chip-q${conditions[group.key] === option ? " is-selected" : ""}`}
                      onClick={() => onCondition(group.key, option)}
                    >
                      {option}
                    </button>
                  ))}
                </div>
              </div>
            ))}
            <div>
              <div style={{ fontWeight: 700, fontSize: 12, color: "var(--dd-stone-500)", marginBottom: 8 }}>
                특이사항
              </div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                {SPECIAL_OPTIONS.map((option) => (
                  <button
                    key={option}
                    type="button"
                    className={`dd-chip-q${conditions.special.includes(option) ? " is-selected" : ""}`}
                    onClick={() => onCondition("special", option)}
                  >
                    {option}
                  </button>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}

      <p className="dd-or-label">또는 바로 물어보세요</p>
      <div className="dd-chip-row">
        {EXAMPLE_CHIPS.map((chip) => (
          <button key={chip} type="button" className="dd-chip-q" onClick={() => onChip(chip)}>
            {chip}
          </button>
        ))}
      </div>
    </div>
  );
}

const getPolicySummaryPayload = (policy, message, index) => {
  if (index === 0 && message.summaryCard) return message.summaryCard;
  return policy.summary_card || policy.summaryCard || {
    summary: policy.summary || policy.reason_summary || policy.reasonSummary || policy.tag || "",
    target:
      policy.target ||
      policy.target_summary ||
      policy.targetSummary ||
      policy.eligibility_summary ||
      policy.eligibilitySummary,
    benefit:
      policy.benefit ||
      policy.benefit_summary ||
      policy.benefitSummary ||
      policy.benefit_amount ||
      policy.benefitAmount,
    apply:
      policy.apply_method ||
      policy.applyMethod ||
      policy.how_to_apply ||
      policy.howToApply,
    key_conditions:
      policy.key_conditions ||
      policy.keyConditions ||
      policy.matched_conditions ||
      policy.matchedConditions ||
      [],
  };
};

const hasPolicySummaryPayload = (policy) => !!(policy?.summary_card || policy?.summaryCard);

const shouldRenderPolicySummaryCards = (message) => {
  const policies = getMessagePolicies(message);
  const actions = message.actions || [];
  if (policies.length !== 1) return false;
  if (
    message.applyCard ||
    hasAction(actions, "apply") ||
    hasAction(actions, "compare") ||
    hasAction(actions, "eligibility") ||
    hasAction(actions, "recommend")
  ) return false;
  return (
    !!message.summaryCard ||
    hasPolicySummaryPayload(policies[0]) ||
    hasSummaryAction(actions)
  );
};

function PolicySummaryCards({ message, onAnalyzeEligibility }) {
  const policies = getMessagePolicies(message);
  if (policies.length === 0) return null;

  return (
    <div className="dd-policy-summary-stack">
      {policies.map((policy, index) => (
        <PolicySummaryCard
          key={getPolicySlug(policy) || getPolicyId(policy) || index}
          policy={policy}
          summaryCard={getPolicySummaryPayload(policy, message, index)}
          onAnalyzeEligibility={(nextPolicy) => onAnalyzeEligibility?.(nextPolicy, message)}
        />
      ))}
    </div>
  );
}

function renderPolicyCards(message, { onAnalyzeEligibility, onAskSimilar, activePolicyId } = {}) {
  const actions = message.actions || [];
  const policies = getMessagePolicies(message);

  if (shouldRenderPolicySummaryCards(message)) {
    return null;
  }

  if (message.applyCard) {
    return (
      <PolicySummaryCard
        policy={message.applyCard}
        summaryCard={message.summaryCard}
        onAnalyzeEligibility={onAnalyzeEligibility}
      />
    );
  }

  if (hasAction(actions, "compare")) {
    return null;
  }

  if (hasAction(actions, "recommend")) {
    return (
      <RecommendChatCard
        policies={policies}
        onAnalyzeEligibility={(policy) => onAnalyzeEligibility?.(policy, message)}
        activePolicyId={activePolicyId}
      />
    );
  }

  if (policies.length > 0) {
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 14 }}>
        {policies.map((policy, index) => (
          <PolicyCardChat
            key={getPolicySlug(policy) || index}
            policy={policy}
            onAnalyzeEligibility={(nextPolicy) => onAnalyzeEligibility?.(nextPolicy, message)}
            onAskSimilar={onAskSimilar}
            analyzing={String(activePolicyId || "") === String(getPolicyId(policy) || "")}
          />
        ))}
        {/* 사용자가 '유사 정책'을 명시 요청했을 때만 백엔드가 실어준 목록을 답변에 노출 */}
        {message.similarPolicies?.length > 0 && (
          <SimilarPolicies
            items={message.similarPolicies}
            layout="sidebar"
            sticky={false}
            title="이런 정책과도 비슷해요"
          />
        )}
      </div>
    );
  }

  return null;
}

function ChatMarkdown({ content, variant = "assistant", isStreaming = false }) {
  if (!content) return null;

  return (
    <div className={`dd-chat-markdown dd-chat-markdown-${variant}`}>
      <ReactMarkdown
        remarkPlugins={CHAT_MARKDOWN_REMARK_PLUGINS}
        skipHtml
        components={{
          a: (props) => {
            const { node, ...linkProps } = props;
            void node;
            return <a {...linkProps} target="_blank" rel="noreferrer" />;
          },
          p: (props) => {
            const { node, ...paragraphProps } = props;
            void node;
            return <p {...paragraphProps} />;
          },
          del: (props) => {
            const { node, ...delProps } = props;
            void node;
            return <span {...delProps} />;
          },
        }}
      >
        {content}
      </ReactMarkdown>
      {isStreaming && <span className="dd-cursor" />}
    </div>
  );
}

const parseCompareGuideContent = (content = "") => {
  const parts = String(content)
    .split(/\n{2,}/)
    .map((part) => part.trim())
    .filter(Boolean);
  if (parts.length <= 1) {
    return { intro: parts[0] || "", guide: "" };
  }
  return {
    intro: parts[0],
    guide: parts.slice(1).join("\n\n"),
  };
};

function CompareGuideChatCard({ content }) {
  const { guide } = parseCompareGuideContent(content);
  const guideParagraphs = guide
    .split(/\n+/)
    .map((part) => part.trim())
    .filter(Boolean);

  return (
    <div className="dd-chat-compare-guide">
      <div className="dd-chat-compare-guide-head">
        <span className="dd-icon-tile dd-tile-amber dd-chat-compare-guide-icon">
          <Icon name="Target" size={18} />
        </span>
        <span className="dd-chat-compare-guide-title-wrap">
          <strong>상황별 선택 가이드</strong>
          <span>두 정책의 장점을 비교해 선택 기준을 정리했어요.</span>
        </span>
        <span className="dd-pill dd-pill-amber dd-chat-compare-guide-pill">
          비교 기준
        </span>
      </div>
      <div className="dd-chat-compare-guide-body">
        {guideParagraphs.length > 0 ? (
          guideParagraphs.map((paragraph, index) => (
            <p key={index}>{paragraph}</p>
          ))
        ) : (
          <p>두 정책의 지원 대상과 혜택 방향을 함께 보고 현재 상황에 더 가까운 정책을 선택해 주세요.</p>
        )}
      </div>
    </div>
  );
}

function RequestStatusMessage({ message, onRetryRequest }) {
  if (
    !message.requestStatus ||
    message.requestStatus === CHAT_REQUEST_UI_STATUS.COMPLETED ||
    message.responseStarted
  ) {
    return null;
  }

  const isFailed = message.requestStatus === CHAT_REQUEST_UI_STATUS.FAILED;
  const isCancelled = message.requestStatus === CHAT_REQUEST_UI_STATUS.CANCELLED;
  const isActive = !isFailed && !isCancelled;
  const hasConfirmedGraphProgress =
    Number(message.progressStep) > 0 && Number(message.progressTotal) > 0;
  const progressPercent = hasConfirmedGraphProgress && Number.isFinite(message.progressPercent)
    ? Math.max(1, Math.min(100, Math.round(message.progressPercent)))
    : null;
  const statusText =
    message.statusText ||
    (isFailed
      ? CHAT_PROGRESS_TEXT.failed
      : message.requestStatus === CHAT_REQUEST_UI_STATUS.RECONNECTING
        ? CHAT_PROGRESS_TEXT.reconnecting
        : message.requestStatus === CHAT_REQUEST_UI_STATUS.CANCELLED
          ? CHAT_PROGRESS_TEXT.cancelled
          : CHAT_PROGRESS_TEXT.processing);

  return (
    <div style={{ marginTop: message.content ? 10 : 0 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, color: "var(--dd-stone-500)", fontSize: 12 }}>
        {isActive && (
          <>
            <span className="dd-typing-dot" style={{ animationDelay: "0s" }} />
            <span className="dd-typing-dot" style={{ animationDelay: ".15s" }} />
            <span className="dd-typing-dot" style={{ animationDelay: ".3s" }} />
          </>
        )}
        {isFailed && <Icon name="CircleAlert" size={14} />}
        {isCancelled && <Icon name="X" size={14} />}
        <span>{statusText}</span>
        {progressPercent !== null && (
          <strong style={{ marginLeft: "auto", color: "var(--dd-ink-80)", fontVariantNumeric: "tabular-nums" }}>
            {progressPercent}%
          </strong>
        )}
      </div>
      {isActive && progressPercent !== null && (
        <div
          role="progressbar"
          aria-label="채팅 응답 처리 진행률"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={progressPercent}
          style={{
            height: 4,
            marginTop: 8,
            overflow: "hidden",
            borderRadius: 999,
            background: "var(--dd-stone-100)",
          }}
        >
          <span
            style={{
              display: "block",
              width: `${progressPercent}%`,
              height: "100%",
              borderRadius: "inherit",
              background: "var(--dd-coral)",
              transition: "width 250ms ease-out",
            }}
          />
        </div>
      )}
      {isFailed && (
        <button
          type="button"
          className="dd-btn dd-btn-ghost dd-btn-sm"
          style={{ marginTop: 10 }}
          onClick={() => onRetryRequest?.(message)}
        >
          <Icon name="Repeat" size={14} /> 다시 시도
        </button>
      )}
    </div>
  );
}

function AssistantMessage({ message, isStreaming, onAnalyzeEligibility, onAskSimilar, activePolicyId, onRetryRequest }) {
  const policySlug = getPolicySlug(message.policies?.[0]);
  const actions = message.actions || [];
  const compareGuideContent = parseCompareGuideContent(message.content);
  const isCompareGuide =
    !isStreaming &&
    hasAction(actions, "compare") &&
    !!compareGuideContent.guide;
  const hasPolicySummaryCard = shouldRenderPolicySummaryCards(message);
  const hasOwnCta =
    !!message.applyCard ||
    hasPolicySummaryCard ||
    hasAction(actions, "compare") ||
    hasAction(actions, "recommend");

  return (
    <div style={{ display: "flex", gap: 12, alignItems: "flex-start" }}>
      <span className="dd-chat-avatar">
        <Icon name="Sparkles" size={20} />
      </span>
      <div className="dd-bubble-ai" style={{ flex: 1, minWidth: 0, maxWidth: 660 }}>
        {message.content && !isCompareGuide && (
          <ChatMarkdown content={message.content} isStreaming={isStreaming} />
        )}
        <RequestStatusMessage message={message} onRetryRequest={onRetryRequest} />
        {isCompareGuide && (
          <>
            {compareGuideContent.intro && (
              <ChatMarkdown content={compareGuideContent.intro} isStreaming={false} />
            )}
            <CompareGuideChatCard content={message.content} />
          </>
        )}

        {!isStreaming && (
          <>
            {renderPolicyCards(message, { onAnalyzeEligibility, onAskSimilar, activePolicyId })}

            {hasPolicySummaryCard ? (
              <PolicySummaryCards
                message={message}
                onAnalyzeEligibility={onAnalyzeEligibility}
              />
            ) : null}

            <EvidencesChat evidences={message.evidences || []} />

            {!hasOwnCta && actions.length > 0 && (
              <div style={{ marginTop: 14 }}>
                <NextActions actions={actions} policySlug={policySlug} />
              </div>
            )}

            {message.disclaimer && (
              <p className="dd-disclaimer" style={{ marginTop: 13, marginBottom: 0 }}>
                <Icon name="ShieldCheck" size={12} /> {DISCLAIMER_TEXT}
              </p>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function ErrorMessage({ message, onRetry }) {
  return (
    <div style={{
      display: "flex",
      alignItems: "flex-start",
      gap: 12,
      background: "var(--dd-coral-50)",
      border: "1px solid var(--dd-coral-200)",
      borderRadius: 14,
      padding: "14px 16px",
    }}>
      <span style={{ color: "var(--dd-coral)", marginTop: 1, display: "inline-flex", flexShrink: 0 }}>
        <Icon name="CircleAlert" size={16} />
      </span>
      <span style={{ flex: 1 }}>
        <span style={{ display: "block", fontSize: 13, color: "var(--dd-stone-600)", lineHeight: 1.6 }}>
          {message}
        </span>
        <button type="button" className="dd-btn dd-btn-ghost dd-btn-sm" style={{ marginTop: 10 }} onClick={onRetry}>
          <Icon name="Repeat" size={14} /> 다시 시도
        </button>
      </span>
    </div>
  );
}

function TypingIndicator() {
  return (
    <div style={{ display: "flex", gap: 12, alignItems: "flex-start" }}>
      <span className="dd-chat-avatar">
        <Icon name="Sparkles" size={20} />
      </span>
      <div className="dd-bubble-ai">
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <span className="dd-typing-dot" style={{ animationDelay: "0s" }} />
          <span className="dd-typing-dot" style={{ animationDelay: ".15s" }} />
          <span className="dd-typing-dot" style={{ animationDelay: ".3s" }} />
          <span style={{ fontSize: 12, color: "var(--dd-stone-400)", marginLeft: 6 }}>
            도담이 입력 중…
          </span>
        </div>
      </div>
    </div>
  );
}

function Sidebar({
  sessions,
  activeSessionId,
  loading,
  onNew,
  onSelect,
  deleteMode = false,
  selectedSessionIds = new Set(),
  deletingSessions = false,
  onToggleDeleteMode,
  onToggleDeleteSelect,
  onDeleteSelected,
}) {
  const selectedCount = selectedSessionIds.size;
  const canDelete = deleteMode && selectedCount > 0 && !deletingSessions;

  return (
    <aside className="dd-sidebar">
      <div className="dd-side-top">
        <button type="button" className="dd-newbtn" onClick={onNew} disabled={deleteMode || deletingSessions}>
          <Icon name="Plus" size={16} /> 새 상담 시작
        </button>
      </div>

      <div className="dd-side-sec">
        <span>상담 이력</span>
        {deleteMode && (
          <span className="dd-side-sec-count">{selectedCount}개 선택</span>
        )}
      </div>

      <div className="dd-side-list">
        {loading ? (
          <p style={{ fontSize: 12, color: "var(--dd-stone-400)", padding: "4px 12px", margin: 0 }}>
            불러오는 중...
          </p>
        ) : sessions.length === 0 ? (
          <p style={{ fontSize: 12, color: "var(--dd-stone-400)", padding: "4px 12px", margin: 0 }}>
            저장된 상담이 없어요.
          </p>
        ) : (
          sessions.map((session) => (
            <button
              key={session.id}
              type="button"
              className={[
                "dd-session",
                activeSessionId === session.id ? "is-active" : "",
                deleteMode ? "is-delete-mode" : "",
                selectedSessionIds.has(session.id) ? "is-selected" : "",
              ].filter(Boolean).join(" ")}
              onClick={() => deleteMode ? onToggleDeleteSelect(session.id) : onSelect(session.id)}
              aria-pressed={deleteMode ? selectedSessionIds.has(session.id) : undefined}
            >
              {deleteMode && (
                <span className="dd-session-check" aria-hidden="true">
                  {selectedSessionIds.has(session.id) && <Icon name="Check" size={13} />}
                </span>
              )}
              <span className="dd-session-copy">
                <span className="dd-session-t">{session.title}</span>
                <span className="dd-session-meta">
                  {session.badge && (
                    <span className={`dd-session-badge dd-session-badge--${session.badge.tone}`}>
                      {session.badge.label}
                    </span>
                  )}
                  {session.lastMessageAt && (
                    <span className="dd-session-m">{formatSessionTime(session.lastMessageAt)}</span>
                  )}
                </span>
              </span>
            </button>
          ))
        )}
      </div>

      <div className="dd-side-foot">
        {deleteMode ? (
          <>
            <button
              type="button"
              className="dd-side-action dd-side-action-ghost"
              onClick={onToggleDeleteMode}
              disabled={deletingSessions}
            >
              <Icon name="X" size={15} /> 취소
            </button>
            <button
              type="button"
              className="dd-side-action dd-side-action-danger"
              onClick={onDeleteSelected}
              disabled={!canDelete}
            >
              <Icon name="Trash2" size={15} /> {deletingSessions ? "삭제 중" : "삭제"}
            </button>
          </>
        ) : (
          <button
            type="button"
            className="dd-side-action dd-side-action-danger"
            onClick={onToggleDeleteMode}
            disabled={loading || sessions.length === 0}
          >
            <Icon name="Trash2" size={15} /> 삭제하기
          </button>
        )}
      </div>
    </aside>
  );
}

export default function ChatPage() {
  const { accessToken, isLoading: authLoading, isAuthenticated } = useContext(AuthContext);
  const [sessions, setSessions] = useState([]);
  const [activeSessionId, setActiveSessionId] = useState(null);
  const [deleteMode, setDeleteMode] = useState(false);
  const [selectedSessionIds, setSelectedSessionIds] = useState(() => new Set());
  const [deletingSessions, setDeletingSessions] = useState(false);
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState("");
  const [loadingSessions, setLoadingSessions] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const [sending, setSending] = useState(false);
  const [lastFailedText, setLastFailedText] = useState("");
  const [error, setError] = useState("");
  const [showConditions, setShowConditions] = useState(false);
  const [conditions, setConditions] = useState({
    stage: "",
    childAge: "",
    income: "",
    region: "",
    special: [],
  });
  const [streamingMessageId, setStreamingMessageId] = useState(null);
  const [activeEligibility, setActiveEligibility] = useState(null);
  const scrollRef = useRef(null);
  const abortRef = useRef(null);
  const restoreAbortRef = useRef(null);
  const recoveryAbortRef = useRef(null);
  const mountedRef = useRef(false);
  // React state updates are asynchronous; this ref closes the same-tick
  // window where a double click/Enter can start a second request before
  // `sending` has re-rendered as true.
  const submissionLockRef = useRef(false);
  const isRecommendRef = useRef(false);
  const followUpMessageKeysRef = useRef(new Set());
  const restoredSessionRef = useRef(false);
  const recoveryStartedRef = useRef(new Set());

  const contextPolicy = useMemo(() => getContextPolicy(messages), [messages]);

  const latestDock = useMemo(() => {
    if (activeEligibility?.questions?.length > 0) {
      return {
        id: `eligibility-${activeEligibility.requestId || activeEligibility.policyId}`,
        flowType: "eligibility",
        requestId: activeEligibility.requestId,
        targetPolicyId: activeEligibility.policyId,
        conditionFilling: {
          title: "지원 가능성 분석에 필요한 정보",
          questions: activeEligibility.questions,
        },
      };
    }

    const latestAssistant = [...messages].reverse().find((msg) => msg.role === "assistant");
    if (
      latestAssistant &&
      (latestAssistant.conditionFilling || latestAssistant.slotRequest || latestAssistant.profileConfirm)
    ) {
      return {
        ...latestAssistant,
        requestId: latestAssistant.recommendationRequestId || latestAssistant.requestId,
      };
    }

    return null;
  }, [activeEligibility, messages]);

  const topTitle = useMemo(() => {
    if (messages.length === 0 && !activeSessionId) return "새 상담";
    return sessions.find((s) => s.id === activeSessionId)?.title || "상담";
  }, [messages.length, activeSessionId, sessions]);

  const hasPendingChatRequest = useMemo(
    () => messages.some((message) => message.role === "assistant" && message.requestStatus && message.requestStatus !== CHAT_REQUEST_UI_STATUS.COMPLETED),
    [messages]
  );

  const hasTickingChatProgress = useMemo(
    () => messages.some((message) =>
      message.role === "assistant" &&
      message.provisional &&
      !message.responseStarted &&
      Number(message.progressStep) > 0 &&
      Number(message.progressTotal) > 0 &&
      [
        CHAT_REQUEST_UI_STATUS.SENDING,
        CHAT_REQUEST_UI_STATUS.PROCESSING,
        CHAT_REQUEST_UI_STATUS.RECONNECTING,
      ].includes(message.requestStatus)
    ),
    [messages]
  );

  useEffect(() => {
    if (!hasTickingChatProgress) return undefined;
    const timer = window.setInterval(() => {
      const now = Date.now();
      setMessages((current) => {
        let changed = false;
        const next = current.map((message) => {
          const shouldTick =
            message.role === "assistant" &&
            message.provisional &&
            !message.responseStarted &&
            Number(message.progressStep) > 0 &&
            Number(message.progressTotal) > 0 &&
            [
              CHAT_REQUEST_UI_STATUS.SENDING,
              CHAT_REQUEST_UI_STATUS.PROCESSING,
              CHAT_REQUEST_UI_STATUS.RECONNECTING,
            ].includes(message.requestStatus);
          if (!shouldTick) return message;
          const progress = tickChatProgress(message, now);
          if (progress.progressPercent === message.progressPercent) return message;
          changed = true;
          return { ...message, ...progress };
        });
        return changed ? next : current;
      });
    }, 250);
    return () => window.clearInterval(timer);
  }, [hasTickingChatProgress]);

  const refreshSessions = useCallback(async () => {
    if (authLoading || !isAuthenticated) return;
    const controller = new AbortController();
    setLoadingSessions(true);
    try {
      const nextSessions = await chatApi.getSessions({ signal: controller.signal });
      setSessions(nextSessions);
    } catch (nextError) {
      if (nextError?.code !== "ERR_CANCELED") {
        setError(getErrorMessage(nextError));
      }
    } finally {
      setLoadingSessions(false);
    }
    return () => controller.abort();
  }, [authLoading, isAuthenticated]);

  useEffect(() => {
    const task = Promise.resolve().then(refreshSessions);
    return () => { task.catch(() => {}); };
  }, [refreshSessions]);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [activeEligibility, messages, sending, restoring, error]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      abortRef.current?.abort();
      restoreAbortRef.current?.abort();
      recoveryAbortRef.current?.abort();
      abortRef.current = null;
      restoreAbortRef.current = null;
      recoveryAbortRef.current = null;
    };
  }, []);

  const ensureSession = useCallback(
    async (firstText) => {
      if (activeSessionId) return activeSessionId;
      const title = firstText.length > 28 ? `${firstText.slice(0, 28)}...` : firstText;
      const created = await chatApi.createSession({ title });
      setActiveSessionId(created.id);
      storeActiveSessionId(created.id);
      setSessions((prev) => [
        { id: created.id, title: title || "새 상담", lastMessageAt: new Date().toISOString(), status: created.status },
        ...prev.filter((session) => session.id !== created.id),
      ]);
      return created.id;
    },
    [activeSessionId]
  );

  const addError = useCallback((message, failedText) => {
    setError(message);
    setLastFailedText(failedText);
  }, []);

  const restoreSessionMessages = useCallback(
    async (sessionId, { clearStoredOnError = false } = {}) => {
      if (!sessionId) return;

      restoreAbortRef.current?.abort();
      const controller = new AbortController();
      restoreAbortRef.current = controller;
      const timeoutId = window.setTimeout(() => controller.abort(), SESSION_RESTORE_TIMEOUT_MS);

      setDeleteMode(false);
      setSelectedSessionIds(new Set());
      setActiveSessionId(sessionId);
      setRestoring(true);
      setSending(false);
      isRecommendRef.current = false;
      setError("");
      setShowConditions(false);
      setActiveEligibility(null);

      try {
        const restoredMessages = await chatApi.getMessages({
          sessionId,
          signal: controller.signal,
        });
        if (!controller.signal.aborted) {
          setMessages(restoredMessages);
          setActiveEligibility(getLatestEligibilityFromMessages(restoredMessages));
        }
      } catch (nextError) {
        if (controller.signal.aborted || nextError?.code === "ERR_CANCELED") {
          addError("세션 메시지 불러오기가 지연되고 있어요. 다시 선택해주세요.", "");
          return;
        }

        if (clearStoredOnError) {
          storeActiveSessionId(null);
          setActiveSessionId(null);
        }
        addError(getErrorMessage(nextError), "");
      } finally {
        window.clearTimeout(timeoutId);
        if (restoreAbortRef.current === controller) {
          restoreAbortRef.current = null;
          setRestoring(false);
        }
      }
    },
    [addError]
  );

  useEffect(() => {
    if (
      restoredSessionRef.current ||
      authLoading ||
      !isAuthenticated ||
      loadingSessions ||
      activeSessionId
    ) {
      return;
    }

    const storedSessionId = readStoredActiveSessionId();
    if (!storedSessionId) {
      restoredSessionRef.current = true;
      return;
    }

    if (sessions.length === 0) {
      return;
    }

    const exists = sessions.some((session) => session.id === storedSessionId);
    if (!exists) {
      storeActiveSessionId(null);
      restoredSessionRef.current = true;
      return;
    }

    let cancelled = false;
    const timeoutId = window.setTimeout(() => {
      if (cancelled) return;
      restoredSessionRef.current = true;
      restoreSessionMessages(storedSessionId, { clearStoredOnError: true });
    }, 0);

    return () => {
      cancelled = true;
      window.clearTimeout(timeoutId);
    };
  }, [
    activeSessionId,
    addError,
    authLoading,
    isAuthenticated,
    loadingSessions,
    restoreSessionMessages,
    sessions,
  ]);

  const updateEligibilityFromResult = useCallback((base, result) => {
    const questions = getEligibilityQuestions(result);
    const status = normalizeEligibilityStatus(result?.status, questions);
    const nextEligibility = {
      ...base,
      status,
      questions: status === REQUEST_STATUS.FOLLOW_UP_REQUIRED ? questions : [],
      criteria: result?.criteria || result?.criteria_results || result?.criteriaResults || [],
      result,
      error: "",
    };

    setActiveEligibility((prev) => ({
      ...(prev || {}),
      ...nextEligibility,
    }));

    if (status === REQUEST_STATUS.FOLLOW_UP_REQUIRED && questions.length > 0) {
      const messageKey = buildEligibilityQuestionKey(nextEligibility);
      if (!followUpMessageKeysRef.current.has(messageKey)) {
        followUpMessageKeysRef.current.add(messageKey);
        const questionMessage = buildEligibilityQuestionMessage(nextEligibility);
        if (questionMessage) {
          setMessages((prev) => [
            ...prev,
            {
              id: makeId("assistant-eligibility-question"),
              role: "assistant",
              content: questionMessage,
              disclaimer: false,
            },
          ]);
        }
      }
    }
  }, []);

  const fetchEligibilityResult = useCallback(
    async (requestId, base) => {
      let result = null;

      for (let attempt = 0; attempt < 15; attempt += 1) {
        result = await eligibilityApi.getResult(requestId);
        updateEligibilityFromResult(base, result);

        const questions = getEligibilityQuestions(result);
        const status = normalizeEligibilityStatus(result?.status, questions);
        if (!ELIGIBILITY_POLLING_STATUSES.has(status)) {
          return result;
        }

        await wait(2000);
      }

      return result;
    },
    [updateEligibilityFromResult]
  );

  const startEligibilityAnalysis = useCallback(
    async (policy, sourceMessage) => {
      if (authLoading || sending || restoring) return;
      if (!isAuthenticated) {
        addError("로그인 후 지원가능성 분석을 이용할 수 있어요.", "");
        return;
      }

      const policyId = getPolicyId(policy);
      const policyName = getPolicyName(policy);

      if (!policyId) {
        addError("지원가능성 분석에 필요한 정책 ID를 확인하지 못했어요.", "");
        return;
      }
      if (submissionLockRef.current) return;
      submissionLockRef.current = true;

      const sourceRefId = getRecommendationSourceRefId(policy, sourceMessage);
      const userConditions =
        policy.selected_conditions ||
        policy.selectedConditions ||
        policy.merged_condition_json ||
        policy.mergedConditionJson ||
        policy.user_conditions ||
        policy.userConditions ||
        {};
      const base = {
        requestId: "",
        policyId,
        policyName,
        sourceType: "RECOMMENDATION_RESULT",
        sourceRefId,
        userConditions,
        status: REQUEST_STATUS.PROCESSING,
        questions: [],
        criteria: [],
        result: null,
        error: "",
        loadingMessage: "추천받은 조건을 기준으로 지원 가능성을 확인하고 있어요.",
      };

      setError("");
      setActiveEligibility(base);

      try {
        const idempotencyKey = createIdempotencyKey();
        const response = await eligibilityApi.createRequest({
          chatSessionId: activeSessionId,
          policyId,
          sourceType: "RECOMMENDATION_RESULT",
          sourceRefId,
          userConditions,
          rawQuery: `${policyName} 지원가능성 분석`,
          idempotencyKey,
        });
        const requestId = getEligibilityRequestId(response);

        if (!requestId) {
          throw new Error("지원가능성 분석 요청 번호를 받지 못했어요.");
        }

        const nextBase = { ...base, requestId: String(requestId) };
        setActiveEligibility(nextBase);
        await fetchEligibilityResult(String(requestId), nextBase);
      } catch (nextError) {
        const message = getApiErrorMessage(nextError, "지원가능성 분석을 시작하지 못했어요.");
        setActiveEligibility((prev) => ({
          ...(prev || base),
          status: REQUEST_STATUS.FAILED,
          questions: [],
          error: message,
        }));
      } finally {
        submissionLockRef.current = false;
      }
    },
    [activeSessionId, addError, authLoading, fetchEligibilityResult, isAuthenticated, restoring, sending]
  );

  const submitEligibilityAnswer = useCallback(
    async (answer) => {
      if (!activeEligibility?.requestId || sending || restoring) return;
      if (submissionLockRef.current) return;
      submissionLockRef.current = true;

      const text = typeof answer === "string" ? answer : answer?.text || answer?.raw_answer || "";

      // answers를 yes/no 확인(manual_confirmations)과 조건값(userConditions 병합)으로 분리한다.
      // SlotDock의 "잘 모르겠어요" 선택은 "__UNKNOWN__"으로 오며, userConditions에서 제외한다.
      const rawAnswers = answer?.answers || {};
      const manualConfirmations = [];
      const conditionUpdates = {};
      for (const [key, value] of Object.entries(rawAnswers)) {
        if (value === "__UNKNOWN__") continue;
        if (["yes", "no", "unknown"].includes(value)) {
          manualConfirmations.push({ question: key, answer: value });
        } else {
          conditionUpdates[key] = value;
        }
      }
      const mergedUserConditions = { ...(activeEligibility.userConditions || {}), ...conditionUpdates };

      const userMessageId = makeId("user-eligibility");
      if (text) {
        setMessages((prev) => [...prev, { id: userMessageId, role: "user", content: text }]);
      }

      setSending(true);
      setError("");
      setActiveEligibility((prev) => ({
        ...prev,
        status: REQUEST_STATUS.PROCESSING,
        questions: [],
        error: "",
        loadingMessage: "입력한 답변을 반영해 지원 가능성을 다시 확인하고 있어요.",
      }));

      try {
        const idempotencyKey = createIdempotencyKey();
        const response = await eligibilityApi.createRequest({
          chatSessionId: activeSessionId,
          policyId: activeEligibility.policyId,
          sourceType: activeEligibility.sourceType,
          sourceRefId: activeEligibility.sourceRefId,
          userConditions: mergedUserConditions,
          rawQuery: text,
          manualConfirmations,
          idempotencyKey,
        });
        const requestId = getEligibilityRequestId(response);
        if (!requestId) {
          throw new Error("지원가능성 분석 요청 번호를 받지 못했어요.");
        }
        const nextEligibility = {
          ...activeEligibility,
          requestId: String(requestId),
          userConditions: mergedUserConditions,
          status: REQUEST_STATUS.PROCESSING,
          questions: [],
          error: "",
          loadingMessage: "입력한 답변을 반영해 지원 가능성을 다시 확인하고 있어요.",
        };
        setActiveEligibility(nextEligibility);
        await fetchEligibilityResult(String(requestId), nextEligibility);
      } catch (nextError) {
        addError(getApiErrorMessage(nextError, "지원가능성 분석 답변을 제출하지 못했어요."), text);
      } finally {
        setSending(false);
        submissionLockRef.current = false;
      }
    },
    [activeEligibility, activeSessionId, addError, fetchEligibilityResult, restoring, sending]
  );

  const submitRecommendationFilling = useCallback(
    async (answer) => {
      if (sending || restoring || authLoading) return;
      if (!isAuthenticated) {
        addError("로그인 후 맞춤 추천을 이용할 수 있어요.", answer?.text || "");
        return;
      }
      if (submissionLockRef.current) return;
      submissionLockRef.current = true;

      const text = answer?.text || answer?.raw_answer || "입력한 조건으로 추천해줘";
      const selectedConditions = normalizeRecommendationAnswers(answer?.answers || {});
      const userMessageId = makeId("user-recommendation");

      setMessages((prev) => [...prev, { id: userMessageId, role: "user", content: text }]);
      setInput("");
      setError("");
      setSending(true);

      const buildAssistantMessage = (requestId, result) => {
        const followUpQuestions = result.followUpQuestions || [];
        return {
          id: makeId("assistant-recommendation"),
          role: "assistant",
          content:
            result.reasonSummary ||
            (result.recommendations?.length > 0
              ? "입력해주신 조건을 기준으로 받을 가능성이 있는 정책을 찾았어요."
              : "추천 결과를 계속 분석 중이에요."),
          policies: result.recommendations || [],
          evidences: [],
          actions: result.recommendations?.length > 0 ? ["recommend"] : [],
          conditionFilling: followUpQuestions.length > 0 ? { questions: followUpQuestions } : null,
          recommendationRequestId: requestId,
          disclaimer: true,
        };
      };

      const pollResult = async (requestId) => {
        let result = await getRecommendationResult(requestId);
        for (let attempt = 0; result.status === "loading" && attempt < 15; attempt += 1) {
          await wait(2000);
          result = await getRecommendationResult(requestId);
        }
        return result;
      };

      try {
        let requestId;
        if (answer?.requestId) {
          // FOLLOW_UP_REQUIRED 상태의 기존 요청에 답변 제출
          requestId = answer.requestId;
          const followUpAnswers = Object.entries(answer?.answers || {}).map(([key, value]) => ({
            question_text: key,
            answer: Array.isArray(value) ? value.join(", ") : String(value ?? ""),
          }));
          await submitRecommendationAnswers(requestId, followUpAnswers);
        } else {
          const idempotencyKey = createIdempotencyKey();
          const created = await createRecommendationRequest({
            source_type: "CHAT",
            raw_query: text,
            selected_conditions: selectedConditions,
            idempotencyKey,
          });
          requestId = created.requestId;
        }

        const result = await pollResult(requestId);
        setMessages((prev) => [...prev, buildAssistantMessage(requestId, result)]);
      } catch (nextError) {
        setMessages((prev) => prev.filter((message) => message.id !== userMessageId));
        addError(
          getApiErrorMessage(nextError, "추천 요청을 생성하지 못했어요. 잠시 후 다시 시도해주세요."),
          text
        );
      } finally {
        setSending(false);
        submissionLockRef.current = false;
        refreshSessions();
      }
    },
    [addError, authLoading, isAuthenticated, refreshSessions, restoring, sending]
  );

  const updateRequestMessage = useCallback((messageId, patch) => {
    setMessages((prev) =>
      prev.map((message) =>
        message.id === messageId
          ? { ...message, ...(typeof patch === "function" ? patch(message) : patch) }
          : message
      )
    );
  }, []);

  const applyCompletedChatPayload = useCallback((payload, { streamId, sessionId, requestId } = {}) => {
    const responseData = payload?.data || payload;
    const assistantPayload = responseData?.assistant_message || responseData?.assistantMessage || responseData;
    const assistantMessage = normalizeAssistantMessage(assistantPayload);

    setMessages((prev) => mergeAssistantMessage(prev, {
      ...assistantMessage,
      requestId: requestId || assistantMessage.requestId,
      requestStatus: CHAT_REQUEST_UI_STATUS.COMPLETED,
      provisional: false,
    }, streamId));

    const eligibilityResult = assistantPayload?.eligibility_result || assistantPayload?.eligibilityResult;
    if (eligibilityResult) {
      setActiveEligibility((prev) => {
        const nextEligibility = buildEligibilityStateFromResult(eligibilityResult, prev || {});
        return nextEligibility || prev;
      });
    }

    if (sessionId) clearPendingChatRequest(sessionId, requestId);
  }, []);

  const recoverChatRequest = useCallback(
    async ({ sessionId, requestId, streamId, userText, idempotencyKey, reason = "reconnecting" }) => {
      if (!sessionId || !requestId) return false;
      recoveryAbortRef.current?.abort();
      const controller = new AbortController();
      recoveryAbortRef.current = controller;
      const startedAt = Date.now();
      let delay = CHAT_RECOVERY_BASE_DELAY_MS;

      updateRequestMessage(streamId, {
        requestStatus: reason === "processing" ? CHAT_REQUEST_UI_STATUS.PROCESSING : CHAT_REQUEST_UI_STATUS.RECONNECTING,
        statusText: reason === "processing" ? CHAT_PROGRESS_TEXT.processing : CHAT_PROGRESS_TEXT.reconnecting,
        requestId,
        idempotencyKey,
        retryText: userText,
      });

      while (!controller.signal.aborted && mountedRef.current) {
        let statusPayload;
        try {
          statusPayload = await chatApi.getRequestStatus({ requestId, signal: controller.signal });
        } catch (nextError) {
          if (controller.signal.aborted || nextError?.code === "ERR_CANCELED") return false;
          statusPayload = null;
        }

        const status = normalizeChatRequestStatusValue(statusPayload?.status);
        if (status === CHAT_REQUEST_UI_STATUS.COMPLETED && statusPayload?.payload) {
          applyCompletedChatPayload(statusPayload.payload, { streamId, sessionId, requestId });
          return true;
        }

        if (status === CHAT_REQUEST_UI_STATUS.FAILED || status === CHAT_REQUEST_UI_STATUS.CANCELLED) {
          clearPendingChatRequest(sessionId, requestId);
          updateRequestMessage(streamId, {
            requestStatus: status,
            statusText:
              status === CHAT_REQUEST_UI_STATUS.CANCELLED
                ? CHAT_PROGRESS_TEXT.cancelled
                : CHAT_PROGRESS_TEXT.failed,
            provisional: false,
            retryText: userText,
          });
          return false;
        }

        updateRequestMessage(streamId, {
          requestStatus: CHAT_REQUEST_UI_STATUS.PROCESSING,
          statusText: CHAT_PROGRESS_TEXT.processing,
        });

        if (Date.now() - startedAt > CHAT_RECOVERY_MAX_WAIT_MS) {
          // Recovery polling timed out, but the durable backend request may still
          // be processing. A transport/recovery timeout must not be rendered as
          // a server-side request failure.
          updateRequestMessage(streamId, {
            requestStatus: CHAT_REQUEST_UI_STATUS.PROCESSING,
            statusText: CHAT_PROGRESS_TEXT.processing,
            provisional: true,
            retryText: userText,
          });
          return false;
        }

        await wait(delay);
        delay = Math.min(delay * 1.6, 6000);
      }

      return false;
    },
    [applyCompletedChatPayload, updateRequestMessage]
  );

  const finalizeSend = useCallback(async (sessionId, text, options = {}) => {
    const isRecommend = isRecommendRef.current;
    isRecommendRef.current = false;

    abortRef.current?.abort();
    const idempotencyKey = options.idempotencyKey || createIdempotencyKey();
    const userMessageId = options.userMessageId || makeId("user");
    const streamId = options.streamId || makeId("assistant-stream");
    const shouldAppendUser = options.appendUser !== false;

    if (shouldAppendUser) {
      setMessages((prev) => [...prev, { id: userMessageId, role: "user", content: text }]);
    }
    setMessages((prev) => {
      if (prev.some((message) => message.id === streamId)) return prev;
      return [...prev, {
        id: streamId,
        role: "assistant",
        content: "",
        policies: [],
        evidences: [],
        actions: [],
        requestStatus: CHAT_REQUEST_UI_STATUS.SENDING,
        statusText: CHAT_PROGRESS_TEXT.accepted,
        requestId: options.requestId || null,
        idempotencyKey,
        provisional: true,
        retryText: text,
        ...createChatProgress(Date.now()),
      }];
    });

    setInput("");
    setError("");
    setLastFailedText(text);
    setSending(true);

    const clearProgress = () => {};


    let streamDone = false;
    let acceptedRequestId = options.requestId || null;
    const controller = new AbortController();
    abortRef.current = controller;

    storePendingChatRequest({
      sessionId,
      requestId: acceptedRequestId,
      idempotencyKey,
      userText: text,
      streamId,
      userMessageId,
    });

    await sendMessageStream({
      sessionId,
      content: text,
      accessToken,
      signal: controller.signal,
      idempotencyKey,
      onAccepted: (event) => {
        if (controller.signal.aborted || !mountedRef.current) return;
        acceptedRequestId = getChatRequestId(event);
        if (!acceptedRequestId) return;
        storePendingChatRequest({
          sessionId,
          requestId: acceptedRequestId,
          idempotencyKey,
          userText: text,
          streamId,
          userMessageId,
        });
        updateRequestMessage(streamId, {
          requestId: acceptedRequestId,
          requestStatus: CHAT_REQUEST_UI_STATUS.PROCESSING,
          statusText: CHAT_PROGRESS_TEXT.accepted,
        });
      },
      onIntent: (event) => {
        if (controller.signal.aborted || !mountedRef.current) return;
        const intent = event.intent || "";
        updateRequestMessage(streamId, (message) => ({
          ...setProgressFlow(message, intent, Date.now()),
          requestId: getChatRequestId(event) || acceptedRequestId,
          requestStatus: CHAT_REQUEST_UI_STATUS.PROCESSING,
          statusText: /recommendation|eligibility/.test(intent)
            ? CHAT_PROGRESS_TEXT.analyzing
            : CHAT_PROGRESS_TEXT.processing,
        }));
      },
      onProgress: (event) => {
        if (controller.signal.aborted || !mountedRef.current) return;
        updateRequestMessage(streamId, (message) => ({
          ...applyProgressEvent(message, event, Date.now()),
          requestId: getChatRequestId(event) || acceptedRequestId,
          requestStatus: CHAT_REQUEST_UI_STATUS.PROCESSING,
          statusText: getProgressMessage(event),
        }));
      },
      onToken: (delta, event) => {
        if (controller.signal.aborted || !mountedRef.current) return;
        if (!delta) return;
        setStreamingMessageId(streamId);
        setMessages((prev) => {
          const current = prev.find((message) => message.id === streamId);
          if (current) {
            return prev.map((message) =>
              message.id === streamId
                ? {
                    ...message,
                    content: `${message.content || ""}${delta}`,
                    responseStarted: true,
                  }
                : message
            );
          }
          return [...prev, {
            id: streamId,
            role: "assistant",
            content: delta,
            policies: [],
            evidences: [],
            actions: [],
            requestId: getChatRequestId(event) || acceptedRequestId,
            requestStatus: CHAT_REQUEST_UI_STATUS.PROCESSING,
            statusText: CHAT_PROGRESS_TEXT.composing,
            provisional: true,
            responseStarted: true,
            retryText: text,
            ...createChatProgress(Date.now()),
          }];
        });
      },
      onDone: (payload, event) => {
        if (controller.signal.aborted || !mountedRef.current) return;
        streamDone = true;
        acceptedRequestId = getChatRequestId(event) || acceptedRequestId;
        clearProgress();
        applyCompletedChatPayload(payload, { streamId, sessionId, requestId: acceptedRequestId });
      },
      onCancelled: (event) => {
        if (controller.signal.aborted || !mountedRef.current) return;
        streamDone = true;
        acceptedRequestId = getChatRequestId(event) || acceptedRequestId;
        clearPendingChatRequest(sessionId, acceptedRequestId);
        updateRequestMessage(streamId, {
          requestId: acceptedRequestId,
          requestStatus: CHAT_REQUEST_UI_STATUS.CANCELLED,
          statusText: CHAT_PROGRESS_TEXT.cancelled,
          provisional: false,
        });
      },
      onError: (event) => {
        if (controller.signal.aborted || !mountedRef.current) return;
        acceptedRequestId = event?.requestId || getChatRequestId(event?.event) || acceptedRequestId;
        clearProgress();
      },
    });

    if (!mountedRef.current) return;

    if (controller.signal.aborted) {
      setSending(false);
      setStreamingMessageId(null);
      if (abortRef.current === controller) abortRef.current = null;
      return;
    }

    if (!streamDone && acceptedRequestId) {
      await recoverChatRequest({
        sessionId,
        requestId: acceptedRequestId,
        streamId,
        userText: text,
        idempotencyKey,
      });
    } else if (!streamDone) {
      setStreamingMessageId(null);
      updateRequestMessage(streamId, {
        requestStatus: CHAT_REQUEST_UI_STATUS.FAILED,
        statusText: CHAT_PROGRESS_TEXT.failed,
        provisional: false,
        retryText: text,
      });
    }

    setSending(false);
    setStreamingMessageId(null);
    clearProgress();
    if (abortRef.current === controller) abortRef.current = null;
    refreshSessions();
  }, [accessToken, applyCompletedChatPayload, recoverChatRequest, refreshSessions, updateRequestMessage]);

  useEffect(() => {
    if (
      authLoading ||
      !isAuthenticated ||
      !activeSessionId ||
      restoring ||
      sending
    ) {
      return;
    }

    let cancelled = false;
    let recoveryKey = null;
    const recoveryStarted = recoveryStartedRef.current;
    const controller = new AbortController();

    const startRecovery = async () => {
      const stored = readPendingChatRequests()[String(activeSessionId)] || null;
      let pending = stored;

      if (!pending?.requestId) {
        try {
          const latest = await chatApi.getLatestIncompleteRequest({
            sessionId: activeSessionId,
            signal: controller.signal,
          });
          if (latest?.requestId) {
            pending = {
              sessionId: activeSessionId,
              requestId: latest.requestId,
              idempotencyKey: latest.idempotencyKey,
              userText: stored?.userText || "",
            };
          }
        } catch (nextError) {
          if (controller.signal.aborted || nextError?.code === "ERR_CANCELED") return;
        }
      }

      if (cancelled || !pending?.requestId) return;
      recoveryKey = `${activeSessionId}:${pending.requestId}`;
      if (recoveryStarted.has(recoveryKey)) return;
      recoveryStarted.add(recoveryKey);

      const streamId = pending.streamId || `assistant-recovery-${pending.requestId}`;
      setMessages((prev) => {
        const hasAssistant =
          prev.some((message) => String(message.requestId || "") === String(pending.requestId)) ||
          prev.some((message) => String(message.raw?.chat_message_id || message.raw?.chatMessageId || "") === String(pending.assistantMessageId || ""));
        if (hasAssistant) return prev;
        return [...prev, {
          id: streamId,
          role: "assistant",
          content: "",
          policies: [],
          evidences: [],
          actions: [],
          requestId: pending.requestId,
          idempotencyKey: pending.idempotencyKey,
          requestStatus: CHAT_REQUEST_UI_STATUS.RECONNECTING,
          statusText: CHAT_PROGRESS_TEXT.reconnecting,
          provisional: true,
          retryText: pending.userText || "",
          ...createChatProgress(Date.now()),
        }];
      });

      try {
        await recoverChatRequest({
          sessionId: activeSessionId,
          requestId: pending.requestId,
          streamId,
          userText: pending.userText || "",
          idempotencyKey: pending.idempotencyKey,
        });
      } finally {
        if (!cancelled) {
          recoveryStarted.delete(recoveryKey);
        }
      }
    };

    startRecovery();

    return () => {
      cancelled = true;
      if (recoveryKey) {
        recoveryStarted.delete(recoveryKey);
      }
      controller.abort();
      recoveryAbortRef.current?.abort();
    };
  }, [activeSessionId, authLoading, isAuthenticated, recoverChatRequest, restoring, sending]);

  const send = useCallback(
    async (raw) => {
      const text = (raw ?? input).trim();
      if (!text || sending || restoring || authLoading) return;
      if (!isAuthenticated) {
        addError("로그인 후 챗봇 상담을 이용할 수 있어요.", text);
        return;
      }
      if (submissionLockRef.current) return;
      submissionLockRef.current = true;
      try {
        if (!isRecommendRef.current) {
          isRecommendRef.current = hasRecommendIntent(text);
        }
        if (isRecommendRef.current) {
          setActiveEligibility(null);
        } else if (
          activeEligibility?.status === REQUEST_STATUS.FOLLOW_UP_REQUIRED ||
          activeEligibility?.questions?.length > 0
        ) {
          setActiveEligibility((prev) => ({
            ...prev,
            status: REQUEST_STATUS.PROCESSING,
            questions: [],
            error: "",
            loadingMessage: "입력한 답변을 반영해 지원 가능성을 다시 확인하고 있어요.",
          }));
        }
        const sessionId = await ensureSession(text);
        await finalizeSend(sessionId, text);
      } catch (nextError) {
        addError(getErrorMessage(nextError), text);
      } finally {
        setSending(false);
        submissionLockRef.current = false;
      }
    },
    [
      activeEligibility,
      addError,
      authLoading,
      ensureSession,
      finalizeSend,
      input,
      isAuthenticated,
      restoring,
      sending,
    ]
  );

  const retryRequestMessage = useCallback(
    async (message) => {
      const text = message?.retryText || lastFailedText;
      if (!text || !activeSessionId || sending || restoring) return;
      if (submissionLockRef.current) return;
      submissionLockRef.current = true;
      try {
        setError("");

        if (message?.requestId) {
          const recovered = await recoverChatRequest({
            sessionId: activeSessionId,
            requestId: message.requestId,
            streamId: message.id,
            userText: text,
            idempotencyKey: message.idempotencyKey,
            reason: "reconnecting",
          });
          if (recovered) return;
        }

        const nextKey = createIdempotencyKey();
        await finalizeSend(activeSessionId, text, {
          appendUser: false,
          streamId: message?.id || makeId("assistant-retry"),
          idempotencyKey: nextKey,
        });
      } finally {
        submissionLockRef.current = false;
      }
    },
    [activeSessionId, finalizeSend, lastFailedText, recoverChatRequest, restoring, sending]
  );

  // 카드의 '유사 정책' 버튼 → 명시 요청을 전송해, 유사 정책을 다음 챗봇 응답으로 받는다.
  const askSimilar = useCallback(
    (policy) => {
      const name = getPolicyName(policy);
      if (!name) return;
      send(`${name} 비슷한 정책 소개해줘`);
    },
    [send]
  );

  const selectSession = useCallback(
    async (sessionId) => {
      if (!sessionId || sessionId === activeSessionId) return;
      storeActiveSessionId(sessionId);
      await restoreSessionMessages(sessionId);
    },
    [activeSessionId, restoreSessionMessages]
  );

  const startNewSession = () => {
    abortRef.current?.abort();
    restoreAbortRef.current?.abort();
    setActiveSessionId(null);
    storeActiveSessionId(null);
    setDeleteMode(false);
    setSelectedSessionIds(new Set());
    setMessages([]);
    setInput("");
    setError("");
    setLastFailedText("");
    setSending(false);
    isRecommendRef.current = false;
    setRestoring(false);
    setShowConditions(false);
    setActiveEligibility(null);
  };

  const toggleDeleteMode = useCallback(() => {
    setDeleteMode((prev) => {
      const next = !prev;
      if (!next) setSelectedSessionIds(new Set());
      return next;
    });
  }, []);

  const toggleDeleteSelect = useCallback((sessionId) => {
    setSelectedSessionIds((prev) => {
      const next = new Set(prev);
      if (next.has(sessionId)) {
        next.delete(sessionId);
      } else {
        next.add(sessionId);
      }
      return next;
    });
  }, []);

  const deleteSelectedSessions = useCallback(async () => {
    if (selectedSessionIds.size === 0 || deletingSessions) return;
    const ids = [...selectedSessionIds];
    setDeletingSessions(true);
    setError("");

    try {
      await chatApi.bulkDeleteSessions(ids);
      setSessions((prev) => prev.filter((session) => !selectedSessionIds.has(session.id)));
      if (activeSessionId && selectedSessionIds.has(activeSessionId)) {
        restoreAbortRef.current?.abort();
        setActiveSessionId(null);
        storeActiveSessionId(null);
        setMessages([]);
        setInput("");
        setLastFailedText("");
        setSending(false);
        setRestoring(false);
        setShowConditions(false);
        setActiveEligibility(null);
      }
      setSelectedSessionIds(new Set());
      setDeleteMode(false);
    } catch (nextError) {
      addError(getErrorMessage(nextError), "");
    } finally {
      setDeletingSessions(false);
    }
  }, [activeSessionId, addError, deletingSessions, selectedSessionIds]);

  const handleQuickAction = (action) => {
    if (action.key === "recommend") {
      setShowConditions(false);
      isRecommendRef.current = true;
      send(action.prompt);
      return;
    }
    if (action.key === "summary") {
      send(action.prompt);
      return;
    }
    send(action.prompt);
  };

  const handleCondition = (key, value) => {
    setConditions((prev) => {
      if (key === "special") {
        return {
          ...prev,
          special: prev.special.includes(value)
            ? prev.special.filter((item) => item !== value)
            : [...prev.special, value],
        };
      }
      return { ...prev, [key]: prev[key] === value ? "" : value };
    });
  };

  const retry = () => {
    const text = lastFailedText;
    setError("");
    if (text) send(text);
  };

  const submitConditions = () => {
    setShowConditions(false);
    isRecommendRef.current = true;
    send(buildRecommendContent(conditions));
  };

  return (
    <div className="dd-page dd-chat-shell">
      <Header />

      <div className="dd-app">
        <Sidebar
          sessions={sessions}
          activeSessionId={activeSessionId}
          loading={loadingSessions}
          onNew={startNewSession}
          onSelect={selectSession}
          deleteMode={deleteMode}
          selectedSessionIds={selectedSessionIds}
          deletingSessions={deletingSessions}
          onToggleDeleteMode={toggleDeleteMode}
          onToggleDeleteSelect={toggleDeleteSelect}
          onDeleteSelected={deleteSelectedSessions}
        />

        <main className="dd-main">
        <div className="dd-topbar">
          <span className="dd-topbar-title">{topTitle}</span>
          {contextPolicy && (
            <>
              <span className="dd-pill dd-pill-coral">
                <Icon name="Sparkles" size={13} /> 현재 대화: {contextPolicy}
              </span>
              <span style={{ fontSize: 12, color: "var(--dd-stone-400)" }}>
                관련 질문을 이어서 물어보세요
              </span>
            </>
          )}
        </div>

        <div className="dd-scroll" ref={scrollRef}>
          <div className="dd-thread">
            {messages.length === 0 ? (
              <EmptyState
                onChip={send}
                onQuickAction={handleQuickAction}
                showConditions={showConditions}
                conditions={conditions}
                onCondition={handleCondition}
                onSubmitConditions={submitConditions}
              />
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
                {messages.map((message) =>
                  message.role === "user" ? (
                    <div key={message.id} style={{ display: "flex", justifyContent: "flex-end" }}>
                      <div className="dd-bubble-user">
                        <ChatMarkdown content={message.content} variant="user" />
                      </div>
                    </div>
                  ) : (
                    <AssistantMessage
                      key={message.id}
                      message={message}
                      isStreaming={message.id === streamingMessageId}
                      onAnalyzeEligibility={startEligibilityAnalysis}
                      onAskSimilar={askSimilar}
                      activePolicyId={activeEligibility?.status === REQUEST_STATUS.PROCESSING ? activeEligibility?.policyId : null}
                      onRetryRequest={retryRequestMessage}
                    />
                  )
                )}
                {activeEligibility && (
                  <div style={{ display: "flex", gap: 12, alignItems: "flex-start" }}>
                    <span className="dd-chat-avatar">
                      <Icon name="ShieldCheck" size={20} />
                    </span>
                    <div className="dd-bubble-ai" style={{ flex: 1, minWidth: 0, maxWidth: 660 }}>
                      <EligibilityCardChat
                        eligibility={activeEligibility}
                        policySlug={getEligibilityPolicySlug(activeEligibility)}
                      />
                    </div>
                  </div>
                )}
                {sending && !streamingMessageId && !hasPendingChatRequest && (
                  <TypingIndicator />
                )}
              </div>
            )}

            {error && (
              <div style={{ marginTop: 12 }}>
                <ErrorMessage message={error} onRetry={retry} />
              </div>
            )}
          </div>
        </div>

        <div className="dd-composer">
          <div className="dd-composer-inner">
            <ChatPromptDock
              key={latestDock?.id}
              slotRequest={latestDock?.slotRequest}
              conditionFilling={latestDock?.conditionFilling}
              profileConfirm={latestDock?.profileConfirm}
              prompt={latestDock?.prompt}
              flowType={latestDock?.flowType}
              requestId={latestDock?.requestId}
              targetPolicyId={latestDock?.targetPolicyId}
              onSubmit={(value) => {
                if (value?.flowType === "eligibility") {
                  submitEligibilityAnswer(value);
                  return;
                }
                if (value?.flowType === "recommendation") {
                  submitRecommendationFilling(value);
                  return;
                }
                send(value);
              }}
              disabled={sending || restoring}
            />
            <form
              className="dd-comp-row"
              onSubmit={(event) => { event.preventDefault(); send(); }}
            >
              <input
                className="dd-input"
                value={input}
                onChange={(event) => setInput(event.target.value)}
                placeholder="가족 상황이나 궁금한 정책을 입력하세요"
                aria-label="메시지 입력"
                disabled={sending || restoring}
                style={{ borderRadius: 999 }}
              />
              <button
                type="submit"
                className="dd-send"
                disabled={!input.trim() || sending || restoring}
                aria-label="전송"
              >
                <Icon name="Send" size={20} color="#fff" />
              </button>
            </form>
            <p className="dd-comp-note">
              <Icon name="MessageCircle" size={12} /> 도담은 정책 이해를 돕는 안내예요. 최종 신청 가능 여부는 공식 기관 확인이 필요합니다.
            </p>
            {!isAuthenticated && !authLoading && (
              <div style={{ display: "flex", justifyContent: "center", marginTop: 8 }}>
                <Link href="/login" className="dd-btn dd-btn-ghost dd-btn-sm">
                  로그인하고 상담 시작
                </Link>
              </div>
            )}
          </div>
        </div>
        </main>
      </div>
    </div>
  );
}
