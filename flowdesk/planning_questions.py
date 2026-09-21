"""Versioned clarification contracts; answers never mutate manual plan content."""
from copy import deepcopy

from .validation import ValidationError, array, identifier, obj, string


def validate_questions(value):
    array(value, "Questions", 3)
    if not value:
        raise ValidationError("Provide at least one question.")
    ids = set()
    for question in value:
        obj(question, {"id", "kind", "prompt", "options", "recommendedOptionId"}, "question")
        key = identifier(question.get("id"), "Question ID")
        if key in ids:
            raise ValidationError("Question IDs must be unique.")
        ids.add(key)
        string(question.get("prompt"), "Question", 500, True)
        options = array(question.get("options"), "Question options", 4)
        if question.get("kind") == "choice":
            if len(options) < 2:
                raise ValidationError("Choice questions need two to four options.")
        elif question.get("kind") != "text" or options:
            raise ValidationError("Use a choice question or a text question without options.")
        option_ids = set()
        for option in options:
            obj(option, {"id", "label", "description"}, "question option")
            key = identifier(option.get("id"), "Option ID")
            if key in option_ids:
                raise ValidationError("Option IDs must be unique within a question.")
            option_ids.add(key)
            string(option.get("label"), "Option label", 200, True)
            string(option.get("description"), "Option description", 300)
        recommendation = question.get("recommendedOptionId")
        if recommendation is not None and (not isinstance(recommendation, str) or recommendation not in option_ids):
            raise ValidationError("The recommended option must belong to this question.")
    return deepcopy(value)


def validate_envelope(response, version):
    if version == 1:
        obj(response, {"message", "proposal"}, "agent reply")
        string(response.get("message"), "Agent message", 24000, True)
        return {"protocolVersion": 1, "kind": "proposal" if response.get("proposal") is not None else "reply",
                "message": response["message"], "proposal": response.get("proposal"), "questions": []}
    obj(response, {"protocolVersion", "kind", "message", "questions", "proposal"}, "agent reply")
    if version not in (2, 3) or type(response.get("protocolVersion")) is not int or response["protocolVersion"] != version:
        raise ValidationError("Unsupported planning response version.")
    kind = response.get("kind")
    if kind not in ("reply", "questions", "proposal"):
        raise ValidationError("Unsupported planning response kind.")
    string(response.get("message"), "Agent message", 24000, kind != "questions")
    array(response.get("questions"), "Questions", 3)
    if kind == "questions":
        validate_questions(response["questions"])
    elif response["questions"]:
        raise ValidationError("Questions must use a questions response.")
    if "proposal" not in response or (kind == "proposal") != (response["proposal"] is not None):
        raise ValidationError("A response must contain either questions, a proposal, or a reply.")
    return deepcopy(response)


def validate_answers(questions, answers):
    array(answers, "Answers", 3)
    if len(answers) != len(questions):
        raise ValidationError("Answer every question before continuing.")
    known = {question["id"]: question for question in questions}
    normalized = {}
    for answer in answers:
        obj(answer, {"questionId", "optionId", "text"}, "answer")
        key = identifier(answer.get("questionId"), "Question ID")
        if key not in known or key in normalized:
            raise ValidationError("Answers must refer to each known question exactly once.")
        if set(answer) != {"questionId", "optionId", "text"}:
            raise ValidationError("Provide an option or custom text for each answer.")
        question = known[key]
        option, text = answer["optionId"], answer["text"]
        if option is not None:
            identifier(option, "Option ID")
            if text is not None or not any(item["id"] == option for item in question["options"]):
                raise ValidationError("Choose a listed option or provide your own answer.")
        else:
            string(text, "Custom answer", 2000, True)
        normalized[key] = deepcopy(answer)
    return [normalized[question["id"]] for question in questions]


def answer_summary(questions, answers):
    lines = []
    for question, answer in zip(questions, answers):
        text = answer["text"] if answer["optionId"] is None else next(
            item["label"] for item in question["options"] if item["id"] == answer["optionId"])
        lines.append(f'{question["prompt"]}\n{text}')
    return "Answers to planning questions:\n\n" + "\n\n".join(lines)
