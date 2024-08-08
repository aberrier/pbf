
import {readFileSync} from 'fs';

const version = JSON.parse(readFileSync(new URL('package.json', import.meta.url))).version;

export function compile(proto) {
    return new Function(`const exports = {};\n${compileRaw(proto, {legacy: true})}\nreturn exports;`)();
}

export function compileRaw(proto, options = {}) {
    const context = buildDefaults(buildContext(proto, null), proto.syntax);

    let output = options.dev ? '' : `// code generated by pbf v${version}\n`;
    if (options.jsDoc) {
        output += typeDef(`import("${options.dev ? '../../index.js' : 'pbf'}").default`, 'Pbf');
    }
    output += writeContext(context, options);
    return output;
}

function writeContext(ctx, options) {
    let code = '';
    if (ctx._proto.fields) code += writeMessage(ctx, options);
    if (ctx._proto.values) code += writeEnum(ctx, options);

    for (let i = 0; i < ctx._children.length; i++) {
        code += writeContext(ctx._children[i], options);
    }
    return code;
}

function writeMessage(ctx, options) {
    const name = ctx._name;
    const fields = ctx._proto.fields;

    let code = '\n';

    if (options.jsDoc) {
        code += compileType(ctx, name, fields);
    }

    if (!options.noRead) {
        const readName = `read${name}`;
        if (options.jsDoc) {
            code += ['\n/**', ' * @param {Pbf} pbf', ' * @param {number} [end]', ` * @returns {${name}}`, ' */'].join('\n').concat('\n');
        }
        code +=
`${writeFunctionExport(options, readName)}function ${readName}(pbf, end) {
    return pbf.readFields(${readName}Field, ${compileDest(ctx)}, end);
}\n`;

        if (options.jsDoc) {
            let param = name;
            if (ctx._proto.map) {
                const {key, value} = getMapTsType(fields);
                param = `{key: ${key}; value: ${value}}`;
            }
            code += ['\n/**', ' * @param {number} tag', ` * @param {${param}} obj`, ' * @param {Pbf} pbf', ' */'].join('\n').concat('\n');
        }
        code +=
`function ${readName}Field(tag, obj, pbf) {
`;
        for (let i = 0; i < fields.length; i++) {
            const field = fields[i];
            const {type, name, repeated, oneof, tag} = field;
            const readCode = compileFieldRead(ctx, field);
            const packed = willSupportPacked(ctx, field);

            let fieldRead =
                type === 'map' ? compileMapRead(readCode, name) :
                repeated ? (packed ? readCode : `obj.${name}.push(${readCode})`) :
                `obj.${name} = ${readCode}`;

            if (oneof) {
                fieldRead += `; obj.${oneof} = ${JSON.stringify(name)}`;
            }

            fieldRead = type === 'map' || oneof ? `{ ${fieldRead}; }` : `${fieldRead};`;

            code +=
`    ${i ? 'else ' : ''}if (tag === ${tag}) ${fieldRead}\n`;
        }
        code += '}\n';
    }

    if (!options.noWrite) {
        const writeName = `write${name}`;

        if (options.jsDoc) {
            let param = name;
            if (ctx._proto.map) {
                const {key, value} = getMapTsType(fields);
                param = `{key: ${key}; value: ${value}}`;
            }

            code += ['\n/**', ` * @param {${param}} obj`, ' * @param {Pbf} pbf', ' */'].join('\n').concat('\n');
        }

        code += `${writeFunctionExport(options, writeName)}function ${writeName}(obj, pbf) {\n`;
        for (const field of fields) {
            const writeCode =
                field.repeated && !isPacked(field) ? compileRepeatedWrite(ctx, field) :
                field.type === 'map' ? compileMapWrite(ctx, field) : compileFieldWrite(ctx, field, `obj.${field.name}`);
            code += getDefaultWriteTest(ctx, field);
            code += `${writeCode};\n`;
        }
        code += '}\n';
    }
    return code;
}

function writeFunctionExport({legacy}, name) {
    return legacy ? `exports.${name} = ${name};\n` : 'export ';
}

function getEnumValues(ctx) {
    const enums = {};
    const ids = Object.keys(ctx._proto.values);
    for (let i = 0; i < ids.length; i++) {
        enums[ids[i]] = ctx._proto.values[ids[i]].value;
    }
    return enums;
}

function writeEnum(ctx, options) {
    const enums = JSON.stringify(getEnumValues(ctx), null, 4);
    const name = ctx._name;

    let code = '\n';
    if (options.jsDoc) {
        code = '\n/** @enum {number} */\n';
    }

    code += `${options.legacy ? `const ${name} = exports.${name}` : `export const ${name}`} = ${enums};\n`;
    return code;
}

function compileDest(ctx) {
    const props = new Set();
    for (const {name, oneof} of ctx._proto.fields) {
        props.add(`${name}: ${JSON.stringify(ctx._defaults[name])}`);
        if (oneof) props.add(`${oneof  }: undefined`);
    }
    return `{${[...props].join(', ')}}`;
}

function isEnum(type) {
    return type && type._proto.values;
}

function getType(ctx, field) {
    if (field.type === 'map') {
        return ctx[getMapMessageName(field.tag)];
    }
    const path = field.type.split('.');
    return path.reduce((ctx, name) => ctx && ctx[name], ctx);
}

function fieldTypeIsNumber(field) {
    switch (field.type) {
    case 'float':
    case 'double':
    case 'uint32':
    case 'uint64':
    case 'int32':
    case 'int64':
    case 'sint32':
    case 'sint64':
    case 'fixed32':
    case 'fixed64':
    case 'sfixed32':
    case 'sfixed64': return true;
    default: return false;
    }
}

function fieldShouldUseStringAsNumber(field) {
    if (field.options.jstype === 'JS_STRING') {
        return fieldTypeIsNumber(field);
    }
    return false;
}

function compileFieldRead(ctx, field) {
    const type = getType(ctx, field);
    if (type) {
        if (type._proto.fields) return `read${type._name}(pbf, pbf.readVarint() + pbf.pos)`;
        if (!isEnum(type)) throw new Error(`Unexpected type: ${type._name}`);
    }

    const fieldType = isEnum(type) ? 'enum' : field.type;

    let prefix = 'pbf.read';
    const signed = fieldType === 'int32' || fieldType === 'int64' ? 'true' : '';
    let suffix = `(${signed})`;

    if (willSupportPacked(ctx, field)) {
        prefix += 'Packed';
        suffix = `(obj.${field.name}${signed ? `, ${signed}` : ''})`;
    }

    if (fieldShouldUseStringAsNumber(field)) {
        suffix += '.toString()';
    }

    switch (fieldType) {
    case 'string':   return `${prefix}String${suffix}`;
    case 'float':    return `${prefix}Float${suffix}`;
    case 'double':   return `${prefix}Double${suffix}`;
    case 'bool':     return `${prefix}Boolean${suffix}`;
    case 'enum':
    case 'uint32':
    case 'uint64':
    case 'int32':
    case 'int64':    return `${prefix}Varint${suffix}`;
    case 'sint32':
    case 'sint64':   return `${prefix}SVarint${suffix}`;
    case 'fixed32':  return `${prefix}Fixed32${suffix}`;
    case 'fixed64':  return `${prefix}Fixed64${suffix}`;
    case 'sfixed32': return `${prefix}SFixed32${suffix}`;
    case 'sfixed64': return `${prefix}SFixed64${suffix}`;
    case 'bytes':    return `${prefix}Bytes${suffix}`;
    default:         throw new Error(`Unexpected type: ${field.type}`);
    }
}

function compileFieldWrite(ctx, field, name) {
    let prefix = 'pbf.write';
    if (isPacked(field)) prefix += 'Packed';

    if (fieldShouldUseStringAsNumber(field)) {
        if (field.type === 'float' || field.type === 'double') {
            name = `parseFloat(${name})`;
        } else {
            name = `parseInt(${name}, 10)`;
        }
    }
    const postfix = `${isPacked(field) ? '' : 'Field'}(${field.tag}, ${name})`;

    const type = getType(ctx, field);
    if (type) {
        if (type._proto.fields) return `${prefix}Message(${field.tag}, write${type._name}, ${name})`;
        if (type._proto.values) return `${prefix}Varint${postfix}`;
        throw new Error(`Unexpected type: ${type._name}`);
    }

    switch (field.type) {
    case 'string':   return `${prefix}String${postfix}`;
    case 'float':    return `${prefix}Float${postfix}`;
    case 'double':   return `${prefix}Double${postfix}`;
    case 'bool':     return `${prefix}Boolean${postfix}`;
    case 'enum':
    case 'uint32':
    case 'uint64':
    case 'int32':
    case 'int64':    return `${prefix}Varint${postfix}`;
    case 'sint32':
    case 'sint64':   return `${prefix}SVarint${postfix}`;
    case 'fixed32':  return `${prefix}Fixed32${postfix}`;
    case 'fixed64':  return `${prefix}Fixed64${postfix}`;
    case 'sfixed32': return `${prefix}SFixed32${postfix}`;
    case 'sfixed64': return `${prefix}SFixed64${postfix}`;
    case 'bytes':    return `${prefix}Bytes${postfix}`;
    default:         throw new Error(`Unexpected type: ${field.type}`);
    }
}

function compileMapRead(readCode, name) {
    return `const {key, value} = ${readCode}; obj.${name}[key] = value`;
}

function compileRepeatedWrite(ctx, field) {
    return `for (const item of obj.${field.name}) ${
        compileFieldWrite(ctx, field, 'item')}`;
}

function compileMapWrite(ctx, field) {
    const name = `obj.${field.name}`;

    return `for (const key of Object.keys(${name})) ${
        compileFieldWrite(ctx, field, `{key, value: ${name}[key]}`)}`;
}

function getMapMessageName(tag) {
    return `_FieldEntry${tag}`;
}

function getMapField(name, type, tag) {
    return {
        name,
        type,
        tag,
        map: null,
        oneof: null,
        required: false,
        repeated: false,
        options: {}
    };
}

function getMapMessage(field) {
    return {
        name: getMapMessageName(field.tag),
        enums: [],
        map: true,
        messages: [],
        extensions: null,
        fields: [
            getMapField('key', field.map.from, 1),
            getMapField('value', field.map.to, 2)
        ]
    };
}

function buildContext(proto, parent) {
    const obj = Object.create(parent);
    obj._proto = proto;
    obj._children = [];
    obj._defaults = {};

    if (parent) {
        parent[proto.name] = obj;

        if (parent._name) {
            obj._name = parent._name + proto.name;
        } else {
            obj._name = proto.name;
        }
    }

    for (let i = 0; proto.enums && i < proto.enums.length; i++) {
        obj._children.push(buildContext(proto.enums[i], obj));
    }

    for (let i = 0; proto.messages && i < proto.messages.length; i++) {
        obj._children.push(buildContext(proto.messages[i], obj));
    }

    for (let i = 0; proto.fields && i < proto.fields.length; i++) {
        if (proto.fields[i].type === 'map') {
            obj._children.push(buildContext(getMapMessage(proto.fields[i]), obj));
        }
    }

    return obj;
}

function getDefaultValue(field, value) {
    // Defaults not supported for repeated fields
    if (field.repeated) return [];
    let convertToStringIfNeeded = function (val) { return val; };
    if (fieldShouldUseStringAsNumber(field)) {
        convertToStringIfNeeded = function (val) { return val.toString(); };
    }

    switch (field.type) {
    case 'float':
    case 'double':   return convertToStringIfNeeded(value ? parseFloat(value) : 0);
    case 'uint32':
    case 'uint64':
    case 'int32':
    case 'int64':
    case 'sint32':
    case 'sint64':
    case 'fixed32':
    case 'fixed64':
    case 'sfixed32':
    case 'sfixed64': return convertToStringIfNeeded(value ? parseInt(value, 10) : 0);
    case 'string':   return value || '';
    case 'bool':     return value === 'true';
    case 'map':      return {};
    default:         return undefined;
    }
}

function willSupportPacked(ctx, field) {
    const fieldType = isEnum(getType(ctx, field)) ? 'enum' : field.type;

    switch (field.repeated && fieldType) {
    case 'float':
    case 'double':
    case 'uint32':
    case 'uint64':
    case 'int32':
    case 'int64':
    case 'sint32':
    case 'sint64':
    case 'fixed32':
    case 'fixed64':
    case 'sfixed32':
    case 'enum':
    case 'bool': return true;
    }

    return false;
}

function setPackedOption(ctx, field, syntax) {
    // No default packed in older protobuf versions
    if (syntax < 3) return;

    // Packed option already set
    if (field.options.packed !== undefined) return;

    // Not a packed field type
    if (!willSupportPacked(ctx, field)) return;

    field.options.packed = 'true';
}

function setDefaultValue(ctx, field, syntax) {
    const options = field.options;
    const type = getType(ctx, field);
    const enumValues = type && type._proto.values && getEnumValues(type);

    // Proto3 does not support overriding defaults
    const explicitDefault = syntax < 3 ? options.default : undefined;

    // Set default for enum values
    if (enumValues && !field.repeated) {
        ctx._defaults[field.name] = enumValues[explicitDefault] || 0;

    } else {
        ctx._defaults[field.name] = getDefaultValue(field, explicitDefault);
    }
}

function buildDefaults(ctx, syntax) {
    const proto = ctx._proto;

    for (let i = 0; i < ctx._children.length; i++) {
        buildDefaults(ctx._children[i], syntax);
    }

    if (proto.fields) {
        for (let i = 0; i < proto.fields.length; i++) {
            setPackedOption(ctx, proto.fields[i], syntax);
            setDefaultValue(ctx, proto.fields[i], syntax);
        }
    }

    return ctx;
}

function getDefaultWriteTest(ctx, field) {
    const def = ctx._defaults[field.name];
    const type = getType(ctx, field);
    let code = `    if (obj.${field.name}`;

    if (!field.repeated && (!type || !type._proto.fields)) {
        if (def === undefined || def || field.oneof) {
            code += ' != null';
        }
        if (def) {
            code += ` && obj.${field.name} !== ${JSON.stringify(def)}`;
        }
    }

    return `${code}) `;
}

function isPacked(field) {
    return field.options.packed === 'true';
}

function getTsType(field) {
    let type = field.type;

    if (fieldShouldUseStringAsNumber(field)) type = 'string';
    else if (fieldTypeIsNumber(field)) type = 'number';
    else if (field.type === 'bytes') type = 'Uint8Array';
    else if (field.type === 'bool') type = 'boolean';

    return field.repeated ? `Array<${type}>` : type;
}

function getMapTsType(fields) {
    const key = getTsType(fields[0]);
    const value = getTsType(fields[1]);
    return {key, value};
}

/**
 * @param {string} type
 * @param {string} name
 * @param {{name: string; type: string; required: boolean}} [fields]
 * @returns {string}
 */
function typeDef(type, name, fields = []) {
    const unionProperties = {};
    const properties = fields.map((field) => {
        if (field.oneof) {
            unionProperties[field.oneof] = unionProperties[field.oneof] || [];
            unionProperties[field.oneof].push(field.name);
        }

        const type = getTsType(field);
        const isRequired = field.required || field.repeated || field.map;

        const name = isRequired ? field.name : `[${field.name}]`;

        return ` * @property {${type}} ${name}`;
    });

    for (const prop in unionProperties) {
        const union = unionProperties[prop].map(s => `"${s}"`).join(' | ');
        properties.push(` * @property {${union}} [${prop}]`);
    }

    return ['/**', ` * @typedef {${type}} ${name}`, ...properties, ' */']
        .join('\n')
        .concat('\n');
}

/**
 * @param {object} ctx
 * @param {string} name
 * @param {{name: string; type: string; required: boolean}} [fields]
 * @returns {string}
 */
function compileType(ctx, name, fields = []) {
    if (ctx._proto.map) {
        const {key, value} = getMapTsType(fields);
        return typeDef(`Object<${key}, ${value}>`, name, []);
    }

    const typedFields = fields.map((field) => {
        const type = getType(ctx, field);
        return {...field, type: type ? type._name : field.type};
    });

    return typeDef('object', name, typedFields);
}
