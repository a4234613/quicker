import { BasePacket, PacketType } from "../../packet/base.packet";
import { BaseHeader, HeaderType } from "../../packet/header/base.header";
import { LongHeader, LongHeaderType } from "../../packet/header/long.header";
import { ShortHeader } from "../../packet/header/short.header";
import { Constants } from "../constants";
import { ConnectionID, PacketNumber, Version } from '../../packet/header/header.properties';
import { QuicError } from "../errors/connection.error";
import { ConnectionErrorCodes } from "../errors/quic.codes";
import { VLIE } from "../../crypto/vlie";
import { Bignum } from "../../types/bignum";
import { VersionValidation } from "../validation/version.validation";
import { VersionNegotiationHeader } from "../../packet/header/version.negotiation.header";
import { VerboseLogging } from "../logging/verbose.logging";


export class HeaderParser {

    /**
     * Method to parse the header of a packet
     * returns a ShortHeader or LongHeader, depending on the first bit
     * @param buf packet buffer
     */
    public parse(buf: Buffer): HeaderOffset[] {
        var headerOffsets: HeaderOffset[] = [];

        var headerOffset: HeaderOffset = this.parseHeader(buf, 0);
        headerOffsets.push(headerOffset);

        //if( headerOffset.header.getHeaderType() == HeaderType.LongHeader )
        //    console.log("Done parsing first long header : ", headerOffset.offset, (<LongHeader>(headerOffset.header)).getPayloadLength().toNumber(), buf.byteLength );

        // There can be multiple QUIC packets inside a single UDP datagram, called a "compound packet"
        // https://tools.ietf.org/html/draft-ietf-quic-transport#section-4.6
        var totalSize: Bignum = new Bignum(0); // REFACTOR TODO: why is this a Bignum? headers can't be that large if they fit inside a UDP packet? 
        // REFACTOR TODO: second condition here should never happen, should throw error message if we encounter this! 
        while (headerOffset.header.getHeaderType() === HeaderType.LongHeader && (<LongHeader>(headerOffset.header)).getPayloadLength() !== undefined) {
            var longHeader: LongHeader = <LongHeader>(headerOffset.header);
            var payloadLength = longHeader.getPayloadLength();

            // REFACTOR TODO: this is a bit of an awkward way to calculate if we still have bytes to process... can't this be done more easily?
            var headerSize = new Bignum(headerOffset.offset).subtract(totalSize);
            totalSize = totalSize.add(payloadLength).add(headerSize);
            if (totalSize.lessThan(buf.byteLength)) {
                // headerOffset.offset is INCLUDING 4 bytes of the packet number
                // headerOffset.header.getPayloadLength() is the length INCLUDING the packet number
                // so, we're actually 4 bytes too far 
                // (put another way: we do 4 bytes of PN + payloadlength, with the payloadLength already including those 4 bytes)
                // see packet number logic in :parseLongHeader below
                // TODO: REFACTOR: this is because the PN isn't always the same size. We deal with this later
                // however, it would make more sense to do decryption in-tandem with parsing probably, and make this loop more robust! 
                headerOffset = this.parseHeader(buf, totalSize.toNumber() - 4);
                headerOffsets.push(headerOffset);
            } else {
                break;
            }
        }

        // Note: section 4.6 says "A packet with a short header does not include a length, so it has to be the last packet included in a UDP datagram."
        // the above while loop will account for that, but only supports a single short header packet at the end

        return headerOffsets;
    }

    private parseHeader(buf: Buffer, offset: number): HeaderOffset {
        // All numeric values are encoded in network byte order (that is, big-endian) and all field sizes are in bits.
        // https://tools.ietf.org/html/draft-ietf-quic-transport#section-4

        // The most significant bit (0x80) of octet 0 (the first octet) is set to 1 for long headers.
        // (0x80 = 0b10000000)
        var type = buf.readUInt8(offset);

        if ((type & 0x80) === 0x80) {
            return this.parseLongHeader(buf, offset);
        }

        return this.parseShortHeader(buf, offset);
    }

    /** 
    * https://tools.ietf.org/html/draft-ietf-quic-transport-20#section-17.2
        0                   1                   2                   3
        0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1
       +-+-+-+-+-+-+-+-+
        |1|1|T T|X X X X|
       +-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
       |                         Version (32)                          |
       +-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
       |DCIL(4)|SCIL(4)|
       +-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
       |               Destination Connection ID (0/32..144)         ...
       +-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
       |                 Source Connection ID (0/32..144)            ...
       +-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
   */
    private parseLongHeader(buf: Buffer, offset: number): HeaderOffset {
        var startOffset = offset; // measured in bytes
        var firstByte = (buf.readUInt8(offset++) - 0xC0); // -0xC0 to remove first 2 bytes (otherwhise, bitwise operators are wonky in JS)

        let type = firstByte >> 4; // with the highest 2 bits removed above, we just drop the 4 rightmost ones to just keep the 2 type bits

        VerboseLogging.debug("HeaderParser:parseLongHeader: type " + type + " // " + LongHeaderType[type] );

        if( type === LongHeaderType.Retry ){
            VerboseLogging.error("headerParser:parseLongHeader : parsing a Retry packet, isn't supported yet! (ODCIL length in first byte)");
            throw new QuicError(ConnectionErrorCodes.PROTOCOL_VIOLATION, "Retry could not be parsed, not supported yet");
        }

        // lower 4 bits are : RESERVED RESERVED PNLENGTH PNLENGTH
        let pnLength = firstByte & 0b00000011;
        pnLength += 1; // is always encoded as 1 less than the actual count, since a PN cannot be 0 bytes long

        let version = new Version(buf.slice(offset, offset + 4)); // version is 4 bytes
        offset += 4;

        if (VersionValidation.IsVersionNegotationFlag(version)) {
            return this.parseVersionNegotiationHeader(buf, offset, type);
        }

        let conLengths = buf.readUInt8(offset++); // single byte containing both ConnectionID lengths DCIL and SCIL 
        // VERIFY TODO: connectionIDs can be empty if the other party can choose them freely
        // connection-id length encoding: we want to encode variable lengths for the Connection IDs of 4 to 18 bytes
        // to save space, we cram this info into 4 bits. Normally, they can only hold 0-15 as values, but because minimum length is 4, we can just do +3 to get the real value
        let dcil = conLengths >> 4; // drop the 4 rightmost bits 
        dcil = dcil === 0 ? dcil : dcil + 3;
        let scil = conLengths & 0b00001111;  
        scil = scil === 0 ? scil : scil + 3;


        let destConnectionID = new ConnectionID(buf.slice(offset, offset + dcil), dcil);
        offset += dcil;
        let srcConnectionID = new ConnectionID(buf.slice(offset, offset + scil), scil);
        offset += scil;

        let tokens:Buffer|undefined = undefined;
        if( type == LongHeaderType.Initial ){

            let tokenLength:Bignum = new Bignum(0);
            // draft-13 added a token in the Initial packet, after the SCID
            // https://tools.ietf.org/html/draft-ietf-quic-transport-13#section-4.4.1
            // TODO: FIXME: actually add these to LongHeader packet, now just done for quick parsing fixing
            let oldOffset = offset;
            let tokenLengthV = VLIE.decode(buf, offset);
            tokenLength = tokenLengthV.value;
            offset = tokenLengthV.offset;
            
            if( tokenLengthV.value.toNumber() > 0 ){
                tokens = Buffer.alloc(tokenLength.toNumber());
                buf.copy(tokens, 0, offset, offset + tokenLength.toNumber());
                offset += tokenLengthV.value.toNumber();
                VerboseLogging.warn("---------------------------------------------");
                VerboseLogging.warn("WARNING: HeaderParser:Initial packet contained reset token, this code is not yet tested, can break! " + tokens.byteLength + " // " + tokens);
                VerboseLogging.warn("---------------------------------------------");
            }
        }

        let payloadLengthV = VLIE.decode(buf, offset);
        var payloadLength = payloadLengthV.value;
        var payloadLengthBuffer = Buffer.alloc(payloadLengthV.offset - offset);
        buf.copy(payloadLengthBuffer, 0, offset, payloadLengthV.offset);
        offset = payloadLengthV.offset;

        var truncatedPacketNumber = new PacketNumber(buf.slice(offset, offset + pnLength));
        offset += pnLength; // offset is now ready, right before the actual payload, which is processed elsewhere 

        console.trace("Payload length ", payloadLength.toNumber() );

        var header = new LongHeader(type, destConnectionID, srcConnectionID, payloadLength, version, payloadLengthBuffer);
        header.setTruncatedPacketNumber( truncatedPacketNumber, new PacketNumber(new Bignum(0)) ); // FIXME: properly pass largestAcked here!!!
        if( tokens )
            header.setInitialTokens(tokens); // also sets initial length 

        // needed for aead encryption later
        // REF TODO 
        var parsedBuffer = buf.slice(startOffset, offset);
        header.setParsedBuffer(parsedBuffer);

        return { header: header, offset: offset };
    }

    private parseVersionNegotiationHeader(buf: Buffer, offset: number, type: number): HeaderOffset {
        var conLengths = buf.readUInt8(offset++); // single byte containing both ConnectionID lengths DCIL and SCIL 
        let destLength = conLengths >> 4; // the 4 leftmost bits are the DCIL : 0xddddssss becomes 0x0000dddd
        destLength = destLength === 0 ? destLength : destLength + 3;
        let srcLength = conLengths & 0xF; // 0xF = 0b1111, so we keep just the 4 rightmost bits 
        srcLength = srcLength === 0 ? srcLength : srcLength + 3;

        // NOTE for above: we want to encode variable lengths for the Connection IDs of 4 to 18 bytes
        // to save space, we cram this info into 4 bits. Normally, they can only hold 0-15 as values, but because minimum length is 4, we can just do +3 to get the real value

        // VERIFY TODO: connectionIDs can be empty if the other party can choose them freely
        let destConnectionID = new ConnectionID(buf.slice(offset, offset + destLength), destLength);
        offset += destLength;
        let srcConnectionID = new ConnectionID(buf.slice(offset, offset + srcLength), srcLength);
        offset += srcLength;

        var header = new VersionNegotiationHeader(destConnectionID, srcConnectionID);
        return { header: header, offset: offset };
    }

    /** 
     * https://tools.ietf.org/html/draft-ietf-quic-transport-20#section-17.3  
         0                   1                   2                   3
         0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1
        +-+-+-+-+-+-+-+-+
        |0|1|S|R|R|K|P P|
        +-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
        |                Destination Connection ID (0..144)           ...
        +-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
        |                     Packet Number (8/16/24/32)              ...
        +-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
        |                     Protected Payload (*)                   ...
        +-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+*/
    private parseShortHeader(buf: Buffer, offset: number): HeaderOffset {
        let startOffset = offset; // measured in bytes

        let firstByte = (buf.readUInt8(offset++) - 0x40); // -0x40 : remove the 0x01 at the start 

        // 3 = 0x20 = spinbit
        // 4 and 5 = 0x18 = reserved
        // 6 = 0x04 = keyphase
        // 7 and 8 = 0x03 = pn length

        let spinBit:boolean     = (firstByte & 0x20) === 0x20; // 0x20 = 0b0010 0000
        let reserved1:boolean   = (firstByte & 0x10) === 0x10; // 0x10 = 0b0001 0000
        let reserved2:boolean   = (firstByte & 0x08) === 0x08; // 0x08 = 0b0000 1000
        let keyPhaseBit:boolean = (firstByte & 0x04) === 0x04; // 0x08 = 0b0000 0100

        let pnLength:number     = firstByte & 0b00000011;
        pnLength += 1;  // is always encoded as 1 less than the actual count, since a PN cannot be 0 bytes long

        // TODO: check that reserved1 and reserved2 are both 0 AFTER removing header protection


        // The destination connection ID is either length 0 or between 4 and 18 bytes long
        // There is no set way of encoding this, we are completely free to choose this ourselves.
        // This is a consequence of the split between Source and Destination Connection IDs
        // For receiving packets, we are the "destination" and we have chosen this ConnID ourselves during connection setup, so we are free to dictate its format
        // For now, we just include an 8-bit length up-front and then decode the rest based on that (see ConnectionID:randomConnectionID)
        // REFACTOR TODO: we currently do not support a 0-length connection ID with our scheme! 
        // REFACTOR TODO: use something like ConnectionID.fromBuffer() here, so that custom logic is isolated in one area 
        let dcil = buf.readUInt8(offset);
        let destConIDBuffer = Buffer.alloc(dcil);
        buf.copy(destConIDBuffer, 0, offset, offset + dcil);

        let destConnectionID = new ConnectionID(destConIDBuffer, dcil);
        offset += dcil;

        let truncatedPacketNumber = new PacketNumber(buf.slice(offset, offset + pnLength));
        offset = offset + pnLength;

        let header = new ShortHeader(destConnectionID, keyPhaseBit, spinBit);
        header.setTruncatedPacketNumber( truncatedPacketNumber, new PacketNumber(new Bignum(0)) ); // FIXME: properly pass largestAcked here!!! 

        let parsedBuffer = buf.slice(startOffset, offset);
        header.setParsedBuffer(parsedBuffer);

        return { header: header, offset: offset };
    }
}
/**
 * Interface so that the offset of the buffer is also returned because it is variable in a shortheader
 */
export interface HeaderOffset {
    header: BaseHeader,
    offset: number
}